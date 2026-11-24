import { recoveryView } from './workflow-control.js';
import {
  canContinueRound,
  canResumeRound,
  canRetryRound,
  roleForStage,
} from './dist/workflow/rules.js';
import { assertScope, scopedFlow, sessionWorkspace } from './dsh-workspace.js';
import { readFileSync } from 'node:fs';
import { readChildRouteEvidence } from './child-route.js';
import { routeSummary } from './dist/storage/workflow-progress.js';
import { sameProjectDirectory } from './dist/storage/project-path.js';
import { join } from 'node:path';
import { getRoleDefinition } from './dist/roles/index.js';
import { hasLiveLock } from './dist/storage/lock.js';
import { failedAttempts } from './workflow-reassignment.js';
import { returnTargets } from './approval-return.js';

const stages = {
  read: '只读分析',
  plan: '计划',
  implement: '开发',
  repair: '修复',
  review: '审查',
  developer_feedback: '开发反馈',
  planner_summary: '最终汇总',
  approval: '人工确认',
  verify: '验证命令',
};
const statuses = {
  running: '执行中',
  completed: '已完成',
  passed: '审查通过',
  cancelled: '已取消',
  failed: '失败',
  blocked: '受阻',
  repair_limit_reached: '已用尽修复次数',
  changes_requested: '需要修改',
  incomplete: '开发未完成',
  waiting_approval: '等待人工确认',
  rejected: '人工确认已拒绝',
  skipped: '已跳过',
};

function readOptionalJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  }
}

function describeStep(entry, view, routes, runs, includeInput = false) {
  const node = routes?.template?.steps.find((step) => step.id === entry.node);
  const role = roleForStage[entry.stage];
  const route =
    entry.routeOverride ||
    node ||
    routes?.roles?.[role] ||
    (role === 'feedback' ? routes?.roles?.developer : undefined);
  const step = {
    id: entry.node ?? entry.stage,
    name: node?.name ?? stages[entry.stage] ?? entry.stage,
    stage: entry.stage,
    kind: node?.kind ?? entry.stage,
    status: entry.status,
    waitingForCapacity: entry.waitingForCapacity === true,
    supersededByApproval: entry.supersededByApproval,
    supersededByRepair: entry.supersededByRepair,
    stoppingJobId: entry.stoppingJobId,
    runId: entry.runId,
    executionId: entry.executionId,
    provider: entry.provider ?? route?.baseBackend ?? route?.backend,
    modelProvider: route?.backend === 'sihq-product-instance' ? undefined : route?.provider,
    model: route?.model,
    reasoningEffort: route?.reasoningEffort,
    instanceName: route?.instanceName,
    agentPreset: route?.agentPreset,
    assignedRoute: includeInput && route ? routeSummary(route) : undefined,
    startedAt: entry.startedAt,
    finishedAt: entry.finishedAt,
    report: runs ? entry.report : undefined,
    error: entry.error,
    skipReason: entry.skipReason,
  };
  // The graph can record skipped or human decisions without a model run.
  if (!runs || !entry.runId || entry.status === 'skipped') return step;
  try {
    const run = runs.read(entry.runId);
    if ((run.workflowId && run.workflowId !== view.id) || !sameProjectDirectory(run.cwd, view.cwd))
      throw new Error('阶段记录与流程不匹配');
    const dir = runs.directory(entry.runId);
    const current = !entry.executionId || run.executionId === entry.executionId;
    let receipt;
    if (includeInput && entry.previousAttempts?.length) {
      step.previousAttempts = entry.previousAttempts.map((attempt) => {
        if (!/^[a-f0-9-]{36}$/i.test(attempt.executionId))
          throw new Error('改派记录中的尝试 ID 无效');
        const prior = readOptionalJson(join(dir, 'dsh-' + attempt.executionId + '.json'));
        return {
          ...attempt,
          input: readOptionalJson(join(dir, 'dsh-input-' + attempt.executionId + '.json')),
          childId: prior?.childId,
          answer: prior?.answer,
          resolvedRoute: prior?.resolvedRoute,
          observedModel: prior?.observedModel,
        };
      });
    }
    if (routes && /^[a-f0-9-]{36}$/i.test(entry.executionId ?? '')) {
      receipt = readOptionalJson(join(dir, 'dsh-' + entry.executionId + '.json'));
      if (includeInput)
        step.input = readOptionalJson(join(dir, 'dsh-input-' + entry.executionId + '.json'));
    }
    step.childId = receipt?.childId ?? (current ? run.threadId : undefined);
    step.observedModel = receipt?.observedModel;
    step.resolvedRoute = receipt?.resolvedRoute;
    if (current) {
      step.provider ??= run.dshProvider;
      step.model ??= run.model;
      step.reasoningEffort ??= run.reasoningEffort;
      step.error ??= run.error;
    }
    if (!step.report && entry.status === 'completed') {
      // Built-in repair can reuse a runId and replace its role artifact. Its
      // per-execution receipt keeps the original implementation report intact.
      if (receipt?.state === 'answered') step.report = JSON.parse(receipt.answer);
      else if (current && run.role) {
        const artifact = getRoleDefinition(run.role, run.purpose).artifactName;
        step.report = readOptionalJson(join(dir, artifact));
      }
      if (!step.report) step.reportError = '此阶段没有可读取的历史报告';
    }
  } catch (error) {
    step.reportError = '阶段详情读取失败：' + error.message;
  }
  return step;
}

function selectRound(flow, requestedRound) {
  const latestRound = flow.round ?? 1;
  const round = requestedRound ?? latestRound;
  if (!Number.isInteger(round) || round < 1) throw new Error('请输入有效轮次');
  const versions = [...(flow.rounds ?? []), flow];
  const view = versions.find((value, index) => (value.round ?? index + 1) === round);
  if (!view) throw new Error('找不到所选轮次');
  return { view, versions, round, latestRound };
}

function runLockState(id, status, current, store, active) {
  let busy = active;
  let lockError;
  if (current && !busy && store && canResumeRound(status)) {
    try {
      busy = hasLiveLock(join(store.directory(id), 'lock'));
    } catch (error) {
      busy = true;
      lockError = '无法确认运行锁的状态：' + error.message;
    }
  }
  const interrupted = current && !!store && !busy && status === 'running';
  return { busy, lockError, interrupted };
}

/**
 * @param {number} [requestedRound]
 * @param {{store?: import('./dist/storage/workflows.js').WorkflowStore, active?: boolean}} [options]
 */
export function describeRun(flow, runs, requestedRound, options = {}) {
  const { store, active = false } = options;
  const { view, versions, round, latestRound } = selectRound(flow, requestedRound);
  const routes = view.dsh ?? flow.dsh;
  const current = view === flow;
  const { busy, lockError, interrupted } = runLockState(
    flow.id,
    view.status,
    current,
    store,
    active,
  );
  return {
    id: flow.id,
    cwd: flow.cwd,
    name: routes?.template?.name ?? 'SiliconHQ 开发流程',
    prompt: view.prompt,
    status: view.status,
    stage: view.stage,
    stopReason: view.stopReason,
    error: view.error,
    updatedAt: view.updatedAt,
    createdAt: view.createdAt,
    latestRound,
    round,
    repairCount: view.repairCount,
    maxRepairs: view.maxRepairs,
    rounds: versions.map((version, index) => ({
      round: version.round ?? index + 1,
      prompt: version.prompt,
      status: version.status,
    })),
    steps: view.steps.map((entry, index) => {
      const step = describeStep(entry, view, routes, runs);
      if (runs) return step;
      return {
        ...step,
        index,
        summary: entry.reportSummary,
        exitCode: entry.exitCode,
        suggestionCount: entry.suggestionCount,
        blockingCount: entry.blockingCount,
        reportAvailable: entry.reportAvailable,
      };
    }),
    pendingApproval:
      current && view.status === 'waiting_approval' ? view.pendingApproval : undefined,
    interrupted,
    busy,
    lockError,
    canResume:
      current && !busy && canResumeRound(view.status) && (view.status !== 'running' || interrupted),
    recovery:
      current && !busy && routes && canResumeRound(view.status)
        ? recoveryView(
            view,
            (step) =>
              routes.template?.steps.find((s) => s.id === step.node)?.name ??
              stages[step.stage] ??
              step.stage,
          )
        : undefined,
    canRetry: current && !busy && !!routes && canRetryRound(view.status),
    reassignable: current && !busy ? failedAttempts(view).map((step) => step.executionId) : [],
    canContinue: current && !busy && !!routes && canContinueRound(view.status, !!routes.template),
  };
}

function scopedProgress(ctx, sessionId, id, store, round, headings = false) {
  const cwd = sessionWorkspace(ctx, sessionId);
  const snapshot = store.readProgress(id, round ?? 0, headings);
  assertScope(snapshot.flow, sessionId, cwd);
  return snapshot;
}

/** @param {import('./dist/storage/workflow-progress.js').RunProgressQuery} query */
export function runProgress(ctx, query, store, active) {
  const { sessionId, id, round, revision } = query;
  const stampFor = (rev, selected, lock) =>
    JSON.stringify([rev, selected, !!active, lock.interrupted, lock.lockError, lock.busy]);
  if (revision) {
    const head = store.readProgressHead(id);
    if (head && (round ?? head.round) === head.round) {
      assertScope(head, sessionId, sessionWorkspace(ctx, sessionId));
      const lock = runLockState(id, head.status, true, store, active);
      if (revision === stampFor(head.revision, head.round, lock))
        return { revision, status: head.status, unchanged: true };
    }
  }
  const snapshot = scopedProgress(ctx, sessionId, id, store, round, true);
  const detail = describeRun(snapshot.flow, undefined, round, { store, active });
  // A crashed process can release a lock without creating a final checkpoint.
  const stamp = stampFor(snapshot.revision, detail.round, detail);
  if (snapshot.headings) detail.rounds = snapshot.headings;
  if (revision === stamp) return { revision: stamp, status: detail.status, unchanged: true };
  // Older progress rows kept the exit code only in the individual command report.
  for (const step of detail.steps) {
    if (step.kind !== 'verify' || !step.reportAvailable || step.exitCode !== undefined) continue;
    const saved = store.readStep(id, detail.round, step.index);
    if (saved.runId === step.runId && saved.executionId === step.executionId)
      step.exitCode = saved.report?.exitCode;
  }
  // An approval saved by an older plugin has no list of eligible rewind targets.
  if (detail.pendingApproval && detail.pendingApproval.targetsVersion !== 2) {
    const full = scopedFlow(ctx, sessionId, id, store);
    if (full.pendingApproval?.id !== detail.pendingApproval.id)
      throw new Error('审批已更新，请刷新运行详情。');
    detail.pendingApproval = {
      ...detail.pendingApproval,
      returnTargets: returnTargets(full, detail.pendingApproval),
    };
  }
  return { ...detail, revision: stamp };
}

export async function runStep(
  ctx,
  { sessionId, id, round, index },
  store,
  runs,
  includeInput = true,
) {
  if (!Number.isSafeInteger(round) || round < 1 || !Number.isSafeInteger(index) || index < 0)
    throw new Error('无效的轮次或步骤编号');
  const { flow } = scopedProgress(ctx, sessionId, id, store, round);
  const { view } = selectRound(flow, round);
  const expected = view.steps[index];
  if (!expected) throw new Error('找不到所选步骤');
  const entry = store.readStep(id, round, index);
  if (entry.runId !== expected.runId || entry.executionId !== expected.executionId)
    throw new Error('步骤已变更，请刷新运行详情');
  const step = describeStep(entry, view, view.dsh ?? flow.dsh, runs, includeInput);
  async function addEvidence(attempt, backend) {
    if (!attempt.childId || attempt.observedModel) return;
    const evidence = await readChildRouteEvidence(ctx, attempt.childId, sessionId, backend);
    if (evidence) {
      if (evidence.fromRequest) attempt.requestRoute = evidence.route;
      else attempt.resolvedRoute ??= evidence.route;
    }
  }
  if (includeInput && (view.dsh ?? flow.dsh)) {
    await addEvidence(step, step.assignedRoute?.backend ?? step.provider);
    for (const prior of step.previousAttempts ?? []) await addEvidence(prior, prior.route?.backend);
  }
  return step;
}

// Only the open approval panel needs these potentially large frozen texts.
export function runApprovalContext(ctx, { sessionId, id, round, approvalId }, store) {
  const flow = scopedFlow(ctx, sessionId, id, store);
  if (
    !flow.dsh ||
    flow.dsh.session !== sessionId ||
    flow.status !== 'waiting_approval' ||
    (flow.round ?? 1) !== round ||
    !approvalId ||
    flow.pendingApproval?.id !== approvalId
  )
    throw new Error('这项审批已失效，请刷新运行详情。');
  return { prompt: flow.prompt, sources: flow.dsh.handoff ?? null };
}

const fieldLabels = {
  summary: '摘要',
  goal: '目标',
  steps: '计划',
  files: '文件',
  description: '说明',
  validation: '验证方式',
  acceptanceCriteria: '验收标准',
  risks: '风险',
  outcome: '开发结果',
  changes: '改动',
  path: '文件',
  validations: '验证',
  command: '命令',
  result: '结果',
  evidence: '证据',
  remaining: '未完成',
  verdict: '审查结论',
  criteria: '验收结果',
  criterion: '标准',
  findings: '发现',
  severity: '严重度',
  location: '位置',
  problem: '问题',
  requestedChange: '修改要求',
  checks: '检查',
  limitations: '限制',
  completedWork: '已完成',
  remainingIssues: '遗留问题',
  issue: '问题',
  reason: '原因',
  attemptedFixes: '已尝试',
  nextStep: '下一步',
  needsUserInput: '需要提供',
  reasonForStopping: '停止原因',
  nextSteps: '后续工作',
  impact: '影响',
  status: '状态',
  decision: '决定',
  note: '备注',
};

function* reportLines(value, indent = '') {
  if (!value || typeof value !== 'object') {
    yield indent + String(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) yield* reportLines(item, indent + '  ');
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (Array.isArray(item) && item.length === 0) continue;
    const label = indent + (fieldLabels[key] ?? key);
    if (item && typeof item === 'object') {
      yield label;
      yield* reportLines(item, indent + '  ');
    } else yield label + ' · ' + String(item);
  }
}

function excerpt(lines, limit) {
  let text = '';
  for (const line of lines) {
    if (text.length + line.length + 1 > limit) {
      const available = Math.max(0, limit - text.length - 2);
      return text + '\n' + line.slice(0, available) + '…';
    }
    text += (text ? '\n' : '') + line;
  }
  return text;
}

export function formatRunResult(detail) {
  const budget = 16000;
  const lines = [
    detail.name + ' · ' + (statuses[detail.status] ?? detail.status),
    '流程 ' + detail.id + ' · 第 ' + detail.round + ' 轮',
    detail.cwd,
  ];
  if (detail.error) lines.push(detail.error.slice(0, 1500));
  if (detail.pendingApproval) {
    lines.push('待确认 · ' + detail.pendingApproval.name, detail.pendingApproval.instructions);
  }
  // Share the space across reports; an oversized first report must not hide the final result.
  const maxSection = Math.min(11000, Math.floor(13000 / Math.max(1, detail.steps.length)));
  for (const step of detail.steps) {
    const heading = [
      step.name,
      step.instanceName ?? step.provider,
      statuses[step.status] ?? step.status,
    ]
      .filter(Boolean)
      .join(' · ');
    const body = [
      step.error,
      step.skipReason,
      step.reportError,
      step.report && excerpt(reportLines(step.report), maxSection),
    ]
      .filter(Boolean)
      .join('\n');
    lines.push(heading + (body ? '\n' + body : ''));
  }
  return excerpt(lines, budget) + '\n完整报告可在聊天的运行详情中查看。';
}
