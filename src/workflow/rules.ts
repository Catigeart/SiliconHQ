import type { WorkflowNode } from './templates.js';

export const roles = ['planner', 'developer', 'reviewer'] as const;
export const builtinRoles = [...roles, 'feedback'] as const;
type BuiltinRole = (typeof builtinRoles)[number];
export const roleForStage = {
  plan: 'planner',
  implement: 'developer',
  repair: 'developer',
  review: 'reviewer',
  developer_feedback: 'feedback',
  planner_summary: 'planner',
} as const;
export const roleLabels = { planner: '计划', developer: '开发与修复', reviewer: '审查' };
export const defaultRepairBudget = 2;
export const defaultBackend = 'spawn';
export const backendKey = (value: unknown) => (typeof value === 'string' ? value.trim() : '');
export const instancePrefix = 'sihq-agent:';
export const instanceKey = (id: string) => instancePrefix + id;
export const defaultWorkflowId = 'siliconhq';
export const defaultNodeRepairs = 0;
export const defaultRoleFields: Record<string, string> = {};
for (const role of builtinRoles) {
  defaultRoleFields[role] = defaultBackend;
  for (const suffix of ['Llm', 'Model', 'ReasoningEffort']) defaultRoleFields[role + suffix] = '';
}

export const kinds = {
  read: '只读分析',
  plan: '计划',
  develop: '开发',
  review: '独立审查',
  approval: '人工确认',
  verify: '运行验证命令',
};
export const isAgentStep = (step: { kind?: string }) =>
  !!step && step.kind !== 'approval' && step.kind !== 'verify';
export function describeExecutor(
  step: WorkflowNode,
  describeAgent: (step: WorkflowNode) => string,
) {
  if (step.kind === 'approval') return '人工确认';
  if (step.kind === 'verify' && step.verification)
    return (
      '验证命令 ' +
      JSON.stringify(step.verification.argv) +
      ' · 限时 ' +
      step.verification.timeoutMs / 1000 +
      ' 秒'
    );
  return describeAgent(step);
}
export function verificationSteps(steps: WorkflowNode[]) {
  return steps.flatMap((step) =>
    step.kind === 'verify' && step.verification ? [{ name: step.name, ...step.verification }] : [],
  );
}
export const outcomes: Partial<Record<WorkflowNode['kind'], Record<string, string>>> = {
  verify: { passed: '验证通过', failed: '验证失败' },
  review: { passed: '审查通过', changes_requested: '需要修改', blocked: '证据不足' },
  develop: { implemented: '已完成开发', incomplete: '未完成开发' },
};
export const canReturnToDeveloper = (kind: string) => kind === 'review' || kind === 'verify';
const providerNames: Record<string, string> = {
  spawn: 'DSH 子 Agent（新会话）',
  fork: 'DSH 分支 Agent（继承父会话历史）',
  'claude-code': 'Claude Code',
  codex: 'Codex',
  'sihq-codex-readonly': 'Codex CLI（强制只读）',
};
export const agentName = (key: string) =>
  Object.hasOwn(providerNames, key) ? providerNames[key] : key;
export const isParallelRead = (step: WorkflowNode) =>
  ['read', 'plan', 'review'].includes(step.kind) && !step.returnTo;
export const canShareInput = (source: WorkflowNode, target: WorkflowNode) =>
  !target.parallelGroup || target.parallelGroup !== source.parallelGroup;
export const canUseAsCondition = (source: WorkflowNode, target: WorkflowNode) =>
  !!outcomes[source.kind] && !source.returnTo && canShareInput(source, target);
export const referencesStep = (source: WorkflowNode, id: string) =>
  source.inputs.includes(id) || source.when?.source === id || source.returnTo === id;

export function sequenceSummary(
  steps: WorkflowNode[],
  describe: (step: WorkflowNode) => string,
): string {
  const prior = new Map<string, WorkflowNode>();
  return steps
    .map((step, index) => {
      const same = step.parallelGroup && steps[index - 1]?.parallelGroup === step.parallelGroup;
      const source = step.when && prior.get(step.when.source);
      const condition =
        step.when && source
          ? '（当' +
            source.name +
            '：' +
            (outcomes[source.kind]?.[step.when.equals] ?? step.when.equals) +
            '）'
          : '';
      prior.set(step.id, step);
      const prefix = index === 0 ? '' : same ? ' ＋ ' : ' → ';
      const start = step.parallelGroup && !same;
      const end = step.parallelGroup && steps[index + 1]?.parallelGroup !== step.parallelGroup;
      const input = step.currentDiff ? '（读取本步骤开始时的 Git diff）' : '';
      return (
        prefix + (start ? '并行〔' : '') + describe(step) + input + condition + (end ? '〕' : '')
      );
    })
    .join('');
}
export function builtinSequenceSummary(
  describeRole: (role: BuiltinRole) => string,
  budget = defaultRepairBudget,
): string {
  const stage = (name: string, role: BuiltinRole) =>
    [name, describeRole(role)].filter(Boolean).join(' · ');
  const main = [
    stage('计划', 'planner'),
    stage('开发', 'developer'),
    stage('独立审查', 'reviewer'),
  ];
  const repair = budget > 0 ? '需修改则回到开发，最多 ' + budget + ' 次。' : '';
  return (
    main.join(' → ') +
    '。' +
    repair +
    '修复额度耗尽且仍需修改时，' +
    stage('开发反馈', 'feedback') +
    ' → ' +
    stage('最终汇总', 'planner')
  );
}

type Issue = { path: [string, number, string]; message: string };
export function stepGraphIssues(steps: WorkflowNode[]): Issue[] {
  const issues: Issue[] = [];
  const seen = new Map<string, WorkflowNode>();
  const groups = new Set<string>();
  steps.forEach((step, index) => {
    const issue = (field: string, message: string) =>
      issues.push({ path: ['steps', index, field], message });
    if (
      step.kind === 'approval' &&
      (step.backend !== 'human' || step.provider || step.model || step.reasoningEffort)
    )
      issue('backend', '人工确认节点的执行者必须为 human，不能指定模型');
    if (step.kind === 'verify') {
      if (step.backend !== 'verification' || step.provider || step.model || step.reasoningEffort)
        issue('backend', '验证步骤由宿主执行，不能指定 Agent 或模型');
      if (!step.verification) issue('verification', '请填写验证命令');
      if (step.inputs.length) issue('inputs', '验证命令使用项目文件，不能将报告插入命令');
    } else if (step.verification) issue('verification', '只有验证步骤可以指定验证命令');
    const group = step.parallelGroup;
    if (step.reviewPolicy && step.kind !== 'review')
      issue('reviewPolicy', '只有审查步骤可以设置验收策略');
    if (step.currentDiff && !isAgentStep(step))
      issue('currentDiff', '只有 Agent 步骤可以引用本步骤开始时的 Git diff');
    if (group) {
      if (!isParallelRead(step))
        issue('parallelGroup', '并行组只能包含只读步骤，组内审查不能设置退回');
      if (steps[index - 1]?.parallelGroup !== group) {
        if (groups.has(group) || steps[index + 1]?.parallelGroup !== group)
          issue('parallelGroup', '同一并行组须由至少两个相邻步骤组成');
        groups.add(group);
      }
    }
    for (const id of step.inputs) {
      const source = seen.get(id);
      if (!source) issue('inputs', '输入必须引用前面已定义的步骤');
      else if (!canShareInput(source, step)) issue('inputs', '同组步骤不能互相引用输入');
    }
    if (step.when) {
      const source = seen.get(step.when.source);
      if (
        !source ||
        !canUseAsCondition(source, step) ||
        !Object.hasOwn(outcomes[source.kind] ?? {}, step.when.equals)
      )
        issue(
          'when',
          '条件必须引用前面的开发、审查或验证结果，来源步骤须无退回，且不能引用同组步骤',
        );
    }
    if (seen.has(step.id)) issue('id', '步骤 ID 重复');
    if (new Set(step.inputs).size !== step.inputs.length) issue('inputs', '步骤输入重复');
    if (
      step.returnTo &&
      (!canReturnToDeveloper(step.kind) || seen.get(step.returnTo)?.kind !== 'develop')
    )
      issue('returnTo', '审查或验证只能退回到前面的开发步骤');
    if (step.maxRepairs > 0 && !step.returnTo) issue('maxRepairs', '设置修复次数前请选择退回步骤');
    seen.set(step.id, step);
  });
  return issues;
}

export function roundConclusion(
  status: 'passed' | 'completed',
  reason: string,
  outstanding: string[],
) {
  return outstanding.length
    ? {
        status: 'incomplete' as const,
        stopReason: 'unhandled_incomplete',
        error: outstanding.join('\n'),
      }
    : { status, stopReason: reason };
}
export function unfinishedWork(name: string, report: Record<string, unknown>) {
  return (
    '「' +
    name +
    '」仍有未完成事项：' +
    (Array.isArray(report.remaining) && report.remaining.length
      ? report.remaining.join('；')
      : String(report.summary ?? '待核对'))
  );
}
export function canRetryRound(status: string) {
  return status === 'failed' || status === 'cancelled';
}
// A running checkpoint is recoverable only after the caller verifies ownership of the lock.
export function canResumeRound(status: string) {
  return canRetryRound(status) || status === 'blocked' || status === 'running';
}

export function assertRoundAction(action: string, status: string, template: boolean) {
  if (action === 'resume' && !canResumeRound(status))
    throw new Error(
      status === 'rejected'
        ? '人工确认已拒绝，此轮已终止。'
        : status === 'waiting_approval'
          ? '当前流程等待人工确认，请在运行详情处理。'
          : '当前轮次不能恢复。已完成的轮次可用 workflow continue 提交追加需求。',
    );
  if (action === 'retry' && !canRetryRound(status))
    throw new Error('retry 只能用于失败或取消的阶段');
  if (action === 'continue' && !canContinueRound(status, template))
    throw new Error('当前轮次尚未结束，请先完成当前轮次');
}

export function canContinueRound(status: string, template: boolean) {
  return (
    ['passed', 'incomplete', 'repair_limit_reached'].includes(status) ||
    (template && ['completed', 'changes_requested'].includes(status))
  );
}

export function workflowRowId(row: { id?: unknown } | null | undefined) {
  return typeof row?.id === 'string' ? row.id.trim() : '';
}
