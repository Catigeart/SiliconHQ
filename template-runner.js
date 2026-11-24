import { archiveCurrentRound } from './dist/storage/workflows.js';
import { assertWorkflowCommand } from './workflow-control.js';
import { whileActive } from './cancellation.js';
import { reassignAttempt, retryAttempts, stepWithOverride } from './workflow-reassignment.js';
import { routeLabel } from './agent-instances.js';
import { checkGateReturn, gateActions, returnTargets, rewindApproval } from './approval-return.js';
import {
  outcomes,
  roundConclusion,
  unfinishedWork,
  canContinueRound,
  canResumeRound,
} from './dist/workflow/rules.js';
import { restoreGraph } from './dist/storage/workflow-graph.js';
import { randomUUID } from 'node:crypto';
import { MissingDiff, stepDiff } from './workflow-git.js';
export { trackedDiff } from './workflow-git.js';
import { z } from 'zod';
import { validateCriteriaReview } from './dist/roles/reviewer.js';
import { buildStepInput, stepReportSchema } from './step-prompt.js';
export { previewStepInput } from './step-prompt.js';
import {
  lockTemplateWorkspace,
  workspaceVerificationStops,
} from './dist/storage/workspace-lock.js';

const stageOf = (kind) => (kind === 'develop' ? 'implement' : kind);

async function nodeInput(flow, step, directory, executionId, retry) {
  const sources = step.inputs.flatMap((id) => {
    const source = previousStep(flow, id);
    if (source?.status === 'skipped') return [];
    if (source?.status !== 'completed' || !source.report)
      throw new Error('步骤缺少已完成的上游报告：' + id);
    return [{ node: id, report: source.report }];
  });
  const feedback = flow.graph.feedback?.target === step.id ? flow.graph.feedback.report : undefined;
  const diff =
    step.currentDiff || (flow.dsh.template.includeDiff && flow.dsh.handoff === undefined)
      ? await stepDiff(flow.cwd, directory, executionId, retry)
      : undefined;
  const inputSources = sources.map(({ node }) => {
    const source = previousStep(flow, node);
    const name = flow.dsh.template.steps.find((item) => item.id === node)?.name ?? node;
    return { id: source.runId, kind: 'report', label: '上游报告 · ' + name };
  });
  if (feedback)
    inputSources.push({
      id: flow.graph.feedback.sourceRunId ?? step.id,
      kind: 'feedback',
      label: feedback.outcome === 'failed' ? '验证失败报告' : '审查退回意见',
    });
  if (diff)
    inputSources.push({ id: 'git-step-diff', kind: 'diff', label: '本步骤开始时的 Git diff' });
  const previousReview =
    step.kind === 'review' && step.reviewPolicy === 'blocking'
      ? flow.steps.findLast(
          (e) => e.node === step.id && e.status === 'completed' && !e.supersededByApproval,
        )?.report
      : undefined;
  const human = flow.graph.humanReturn;
  let returned;
  if (human?.target === step.id) {
    returned = {
      note: human.note,
      report: flow.steps.find((entry) => entry.runId === human.previousRun)?.report,
    };
    inputSources.push({ id: human.approvalId, kind: 'feedback', label: '人工退回修改意见' });
    inputSources.push({ id: human.previousRun, kind: 'report', label: '退回前的步骤报告' });
  }
  return {
    ...buildStepInput(step, flow.prompt, sources, { feedback, diff, previousReview, returned }),
    inputSources,
  };
}

function previousStep(flow, id) {
  return flow.steps.findLast(
    (entry) => entry.node === id && !entry.supersededByApproval && !entry.supersededByRepair,
  );
}

function skipReason(flow, step) {
  if (!step.when) return undefined;
  const source = previousStep(flow, step.when.source);
  const origin = flow.dsh.template.steps.find((node) => node.id === step.when.source);
  const sourceName = origin.name;
  const conditionLabels = outcomes[origin.kind];
  if (source?.status === 'skipped') return '条件来源「' + sourceName + '」已跳过';
  if (source?.status !== 'completed' || !source.report)
    throw new Error('条件来源「' + sourceName + '」缺少报告');
  const result = source.report.verdict ?? source.report.outcome;
  if (result !== step.when.equals)
    return (
      '「' +
      sourceName +
      '」的结果为「' +
      conditionLabels[result] +
      '」，此步骤要求「' +
      conditionLabels[step.when.equals] +
      '」'
    );
}

function createEntry(flow, step, runs) {
  const run = runs.create(flow.prompt, flow.cwd);
  const entry = {
    node: step.id,
    stage: stageOf(step.kind),
    runId: run.id,
    executionId: randomUUID(),
    status: 'running',
    provider: step.baseBackend ?? step.backend,
    startedAt: run.createdAt,
  };
  flow.steps.push(entry);
  return entry;
}

function batchEntries(flow, batch, runs) {
  if (flow.graph.batch) {
    if (flow.graph.batch.length !== batch.length) throw new Error('并行执行记录与快照不一致');
    return flow.graph.batch.map((id, i) => {
      const entry = flow.steps.find((s) => s.runId === id);
      if (!entry || entry.node !== batch[i]?.id) throw new Error('并行执行记录与快照不一致');
      return entry;
    });
  }
  const entries = batch.map((step) => createEntry(flow, step, runs));
  flow.graph.batch = entries.map((entry) => entry.runId);
  return entries;
}

async function executeEntry({
  flow,
  step,
  entry,
  runs,
  request,
  signal,
  observer,
  delegate,
  verify,
  waitForStop,
  recordStopping,
  persist,
}) {
  if (['completed', 'skipped'].includes(entry.status)) return;
  const run = runs.read(entry.runId);
  if (entry.previousAttempts?.length && run.executionId !== entry.executionId) {
    delete run.threadId;
    delete run.model;
  }
  const retry =
    request.action === 'retry' && ['failed', 'cancelled', 'running'].includes(entry.status);
  // The command can modify the worktree. A lost response must never launch it twice.
  if (step.kind === 'verify' && entry.verificationStartedAt) {
    if (entry.status === 'running') {
      entry.status = run.status = 'failed';
      entry.error = run.error = '验证命令的执行结果未知。请检查工作区后显式重试。';
      runs.save(run);
      persist();
    }
    return;
  }
  function countAcceptedRepair() {
    const feedback = flow.graph.feedback;
    if (feedback?.target !== step.id || !feedback.pendingReview) return;
    const review = feedback.pendingReview;
    const counts = flow.graph.counts;
    const previous = Object.hasOwn(counts, review) ? counts[review] : 0;
    flow.graph.counts = { ...counts, [review]: previous + 1 };
    flow.repairCount++;
    delete feedback.pendingReview;
    persist();
  }
  Object.assign(run, {
    dshProvider: entry.provider,
    workflowId: flow.id,
    executionId: entry.executionId,
    status: 'running',
  });
  if (step.model) run.model = step.model;
  entry.status = 'running';
  delete entry.error;
  delete run.error;
  delete entry.blocked;
  try {
    signal.throwIfAborted();
    const reason = skipReason(flow, step);
    if (reason) {
      entry.status = run.status = 'skipped';
      entry.skipReason = reason;
      entry.finishedAt = new Date().toISOString();
      observer.log('[跳过] ' + step.name + ' · 条件未命中');
      return;
    }
    runs.save(run);
    observer.onStage(step.name, run);
    if (step.kind === 'verify') {
      if (!verify) throw new Error('此宿主没有可用的验证命令执行服务');
      entry.verificationStartedAt = new Date().toISOString();
      persist();
      observer.log('[验证] ' + step.name + ' · ' + JSON.stringify(step.verification.argv));
      const report = await verify(
        step.verification,
        flow.cwd,
        signal,
        (jobId) => {
          recordStopping(entry, jobId);
          if (jobId) observer.log('[验证] 正在等待宿主停止任务 · ' + jobId);
        },
        (work, active) => waitForStop(entry, work, active),
      );
      entry.report = report;
      entry.finishedAt = new Date().toISOString();
      const handledFailure =
        report.commandFailed === true &&
        (step.returnTo ||
          flow.dsh.template.steps.some(
            (node) => node.when?.source === step.id && node.when.equals === 'failed',
          ));
      if (
        signal.aborted ||
        (!handledFailure && (report.outcome !== 'passed' || report.exitCode !== 0))
      )
        throw new Error(report.summary || '验证命令未通过');
      entry.status = run.status = 'completed';
      return;
    }
    const { prompt, criteria, inputSources } = await nodeInput(
      flow,
      step,
      runs.directory(run.id),
      entry.executionId,
      retry,
    );
    observer.onDispatch(run, step.name);
    observer.log('[委派] ' + step.name + ' → ' + routeLabel(step));
    const schema = stepReportSchema(step);
    const answer = await delegate(step, {
      directory: runs.directory(run.id),
      executionId: entry.executionId,
      workflowId: flow.id,
      label: step.name,
      prompt,
      inputSources,
      active: signal,
      schema: z.toJSONSchema(schema),
      onWaiting: () => {
        entry.waitingForCapacity = true;
        persist();
        observer.onWaiting?.(step.name);
      },
      onChild: (id) => {
        countAcceptedRepair();
        if (entry.waitingForCapacity) {
          delete entry.waitingForCapacity;
          observer.onStage(step.name, run);
          persist();
        }
        run.threadId = id;
        runs.save(run);
      },
    });
    countAcceptedRepair(); // Some delegates return an answer without reporting their child ID.
    signal.throwIfAborted();
    const report =
      step.kind === 'review'
        ? validateCriteriaReview(answer, criteria, step.reviewPolicy)
        : schema.parse(JSON.parse(answer));
    Object.assign(entry, {
      report,
      status: 'completed',
      finishedAt: new Date().toISOString(),
      verdict: report.verdict,
      outcome: report.outcome,
    });
    Object.assign(run, {
      status: 'completed',
      reviewVerdict: report.verdict,
      implementationOutcome: report.outcome,
    });
  } catch (error) {
    entry.status = run.status = signal.aborted ? 'cancelled' : 'failed';
    entry.error = run.error = error instanceof Error ? error.message : String(error);
    entry.blocked = !signal.aborted && error instanceof MissingDiff;
  } finally {
    delete entry.waitingForCapacity;
    runs.save(run);
    persist(); // Each member is durable before a retry can start.
  }
}

function finishRound(flow, status, reason) {
  // Replay the durable entries in order. A later repair can replace an earlier outcome,
  // and a handler only consumes its source outcome once the handler actually completes.
  const nodes = new Map(flow.dsh.template.steps.map((node) => [node.id, node]));
  const outstanding = new Map();
  const latest = new Map(
    flow.steps
      .filter((entry) => !entry.supersededByApproval && !entry.supersededByRepair)
      .map((entry) => [entry.node, entry]),
  );
  for (const node of nodes.values()) {
    const entry = latest.get(node.id);
    if (entry?.status !== 'completed' || !entry.report) continue;
    if (node.when?.equals === 'incomplete') outstanding.delete(node.when.source);
    if (node.kind === 'develop') {
      if (entry.report.outcome === 'incomplete') outstanding.set(node.id, entry.report);
      else if (entry.report.outcome === 'implemented') outstanding.delete(node.id);
    }
  }
  Object.assign(
    flow,
    roundConclusion(
      status,
      reason,
      [...outstanding].map(([id, report]) => unfinishedWork(nodes.get(id).name, report)),
    ),
  );
}

function settleBatch(flow, batch, entries, steps) {
  const failure =
    entries.find((entry) => entry.status === 'failed' && !entry.blocked) ??
    entries.find((entry) => entry.status === 'cancelled') ??
    entries.find((entry) => entry.status === 'failed');
  if (failure) {
    flow.status = failure.blocked ? 'blocked' : failure.status;
    flow.error = failure.error;
    if (failure.blocked) flow.stopReason = 'verification_blocked';
    return;
  }
  const reviews = entries
    .map((entry, i) => ({ step: batch[i], entry }))
    .filter(
      ({ step, entry }) =>
        step.kind === 'review' &&
        entry.report &&
        !steps.some((s) => s.when?.source === step.id && s.when.equals === entry.report.verdict),
    );
  const blocked = reviews.filter(({ entry }) => entry.report.verdict === 'blocked');
  if (blocked.length) {
    flow.status = 'blocked';
    flow.stopReason = 'verification_blocked';
    // On resume re-read only blocked reviews; siblings have already completed.
    flow.graph.recheck = blocked.map(({ step }) => step.id);
    return;
  }
  delete flow.graph.batch;
  const rejected =
    reviews.find(({ entry }) => entry.report.verdict === 'changes_requested') ??
    (batch[0].kind === 'verify' && batch[0].returnTo && entries[0].report?.commandFailed
      ? { step: batch[0], entry: entries[0] }
      : undefined);
  if (rejected) {
    const { step, entry } = rejected;
    const count = Object.hasOwn(flow.graph.counts, step.id) ? flow.graph.counts[step.id] : 0;
    if (step.returnTo && count < step.maxRepairs && flow.repairCount < flow.maxRepairs) {
      const targetIndex = steps.findIndex((s) => s.id === step.returnTo);
      const target = steps[targetIndex];
      const human = flow.graph.humanReturn;
      if (human && targetIndex < steps.findIndex((node) => node.id === human.target)) {
        flow.status = 'changes_requested';
        flow.stopReason = 'repair_outside_approved_return';
        flow.error =
          '该步骤要求重新执行「' + target.name + '」，已超出本次人工退回指定的重跑范围。';
        return;
      }
      const reason = skipReason(flow, target);
      if (reason) {
        flow.status = 'changes_requested';
        flow.stopReason = 'repair_target_skipped';
        flow.error = '该步骤要求修改，退回目标「' + target.name + '」未执行：' + reason;
        return;
      }
      const { suggestions, ...repairReport } = entry.report;
      flow.graph.feedback = {
        target: target.id,
        report: repairReport,
        pendingReview: step.id,
        sourceRunId: entry.runId,
      };
      const rewound = new Set(
        steps.slice(targetIndex, flow.graph.cursor + batch.length).map((s) => s.id),
      );
      for (const old of flow.steps) {
        if (rewound.has(old.node) && !old.supersededByApproval && !old.supersededByRepair)
          old.supersededByRepair = entry.runId;
      }
      flow.graph.cursor = targetIndex;
    } else {
      flow.status = step.returnTo ? 'repair_limit_reached' : 'changes_requested';
      flow.stopReason = step.returnTo ? 'repair_budget_exhausted' : 'review_changes_requested';
    }
    return;
  }
  if (batch.some((step) => step.id === flow.graph.feedback?.target)) delete flow.graph.feedback;
  flow.graph.cursor += batch.length;
  if (flow.graph.cursor === steps.length) {
    const last = entries.findLast((entry) => entry.status === 'completed');
    const passed = last?.report?.verdict === 'passed';
    finishRound(
      flow,
      passed ? 'passed' : 'completed',
      passed ? 'review_passed' : 'steps_completed',
    );
  }
}

export async function runTemplate({
  request,
  replacement = undefined,
  flows,
  runs,
  cwd,
  frozen,
  observer,
  signal,
  globalBudget,
  delegate,
  stopJob = /** @type {((id: string) => Promise<void>) | undefined} */ (undefined),
  verify = /** @type {((command: {argv: string[], timeoutMs: number}, cwd: string, signal: AbortSignal, onStopping: (id?: string) => void, waitForStop: (work: Promise<void>, active: AbortSignal) => Promise<boolean>) => Promise<object>) | undefined} */ (
    undefined
  ),
}) {
  const plan = request.action === 'start' ? frozen : flows.readCurrent(request.id).dsh;
  const shared = plan.template.steps.every((node) =>
    ['read', 'plan', 'review', 'approval'].includes(node.kind),
  );
  const { release: releaseWorkspace, assertReady } = lockTemplateWorkspace(
    cwd,
    shared ? 'read' : 'write',
    request.action === 'start' ? undefined : request.id,
  );
  let releaseFlow;
  let cleanup;
  const unlock = () => {
    try {
      releaseFlow?.();
    } finally {
      releaseWorkspace();
    }
  };
  try {
    let flow =
      request.action === 'start'
        ? flows.create(request.prompt, cwd, globalBudget, frozen)
        : undefined;
    releaseFlow = flows.lock(flow?.id ?? request.id);
    flow ??= flows.readCurrent(request.id);
    if (
      request.action === 'resume' &&
      request.expectedState === undefined &&
      !canResumeRound(flow.status)
    )
      return flow;
    assertWorkflowCommand(flow, request);
    const steps = flow.dsh.template.steps;
    const fresh = () => ({ version: 1, cursor: 0, counts: {} });
    // Early templates can have a terminal report without a cursor. Continuation archives that
    // record and starts at zero. Recovery of an active round always requires a valid snapshot.
    if (flow.graph || !canContinueRound(flow.status, true)) flow.graph = restoreGraph(flow, steps);
    const save = () => {
      flows.save(flow);
      observer.onUpdate(flow);
    };
    const stops = workspaceVerificationStops(cwd, flow.id);
    function recordStopping(entry, jobId) {
      if (jobId) {
        stops.remember(entry.runId, jobId);
        entry.stoppingJobId = jobId;
      } else {
        const confirmed = entry.stoppingJobId;
        delete entry.stoppingJobId;
        flows.save(flow);
        if (confirmed) stops.confirmed(confirmed);
        return;
      }
      save();
    }
    async function waitForStop(entry, work, active) {
      try {
        await whileActive(work, active);
        return true;
      } catch (error) {
        if (!active.aborted) throw error;
        // Keep the original locks until the host has confirmed termination.
        cleanup = () =>
          work.then(() => {
            recordStopping(entry, undefined);
          });
        return false;
      }
    }
    for (const pending of shared ? [] : stops.pending()) {
      const entry = flow.steps.find((s) => s.runId === pending.runId);
      if (!entry || (entry.stoppingJobId && entry.stoppingJobId !== pending.jobId))
        throw new Error('验证任务与流程检查点不一致：' + pending.jobId);
      entry.stoppingJobId = pending.jobId;
    }
    for (const entry of flow.steps.filter((s) => s.stoppingJobId)) {
      stops.remember(entry.runId, entry.stoppingJobId);
      if (!stopJob) throw new Error('无法确认验证任务是否已停止 · ' + entry.stoppingJobId);
      if (!(await waitForStop(entry, stopJob(entry.stoppingJobId), signal))) {
        // Cancelling a recovery attempt must not overwrite the previous result.
        signal.throwIfAborted();
      }
      recordStopping(entry, undefined);
    }
    assertReady();
    if (request.action !== 'start') signal.throwIfAborted();
    if (request.action === 'retry') retryAttempts(flow, runs);
    let onlyAttempt;
    if (request.action === 'reassign') {
      if (!replacement || request.confirmed !== true) throw new Error('改派缺少已确认的目标实例');
      signal.throwIfAborted();
      onlyAttempt = reassignAttempt(flow, request, replacement, runs);
    }
    const decision = gateActions.includes(request.action);
    if (decision) {
      const gate = flow.pendingApproval;
      if (steps[flow.graph.cursor]?.id !== gate.node)
        throw new Error('此确认已失效，请查看当前运行状态');
      signal.throwIfAborted();
      const approved = request.action === 'approve';
      const target = request.action === 'return' ? checkGateReturn(flow, gate, request) : undefined;
      const run = runs.read(gate.id);
      if (run.workflowId !== flow.id || run.dshProvider !== 'human')
        throw new Error('人工确认记录与流程不匹配，原记录已保留');
      run.status = 'completed';
      runs.save(run);
      flow.steps.push({
        node: gate.node,
        stage: 'approval',
        runId: gate.id,
        status: 'completed',
        startedAt: run.createdAt,
        finishedAt: new Date().toISOString(),
        report: {
          decision: target ? 'returned' : approved ? 'approved' : 'rejected',
          summary: target ? '已退回「' + target.name + '」修改' : approved ? '已批准' : '已拒绝',
          ...(target && { target: target.id }),
          ...(request.note && { note: request.note }),
        },
      });
      delete flow.pendingApproval;
      if (target) rewindApproval(flow, gate, target, request.note.trim());
      else flow.graph.cursor++;
      flow.status = approved || target ? 'running' : 'rejected';
      flow.stopReason = target ? 'human_returned' : approved ? 'approved' : 'human_rejected';
      if (approved && flow.graph.cursor === steps.length)
        finishRound(flow, 'completed', 'approved');
      save(); // Advance the cursor and consume this one-time gate in the same checkpoint.
      if (flow.status !== 'running') return flow;
    } else if (flow.status === 'waiting_approval' || flow.status === 'rejected') {
      throw new Error(
        flow.status === 'rejected' ? '人工确认已拒绝，此轮已终止' : '请先处理当前人工确认',
      );
    }
    if (request.action === 'continue') {
      Object.assign(flow, {
        ...archiveCurrentRound(flow),
        dsh: frozen,
        round: (flow.round ?? 1) + 1,
        graph: fresh(),
        steps: [],
        repairCount: 0,
        prompt: request.prompt,
      });
    }
    flow.status = 'running';
    delete flow.error;
    delete flow.stopReason;
    save();
    while (flow.graph.cursor < steps.length) {
      if (signal.aborted) {
        flow.status = 'cancelled';
        flow.stopReason = 'cancelled';
        save();
        break;
      }
      const index = flow.graph.cursor,
        step = steps[index];
      flow.stage = stageOf(step.kind);
      if (
        step.kind === 'approval' &&
        (flow.graph.humanReturn?.gate === step.id || !skipReason(flow, step))
      ) {
        const run = runs.create(flow.prompt, cwd);
        run.workflowId = flow.id;
        run.dshProvider = 'human';
        runs.save(run);
        flow.pendingApproval = {
          id: run.id,
          node: step.id,
          name: step.name,
          instructions: step.instructions,
          inputs: step.inputs,
          targetsVersion: 2,
          returnTargets: returnTargets(flow, { node: step.id }),
        };
        if (flow.graph.humanReturn?.gate === step.id) delete flow.graph.humanReturn;
        flow.status = 'waiting_approval';
        flow.stopReason = 'awaiting_human_decision';
        observer.log('[等待确认] ' + step.name);
        save();
        return flow;
      }
      let end = index + 1;
      while (step.parallelGroup && steps[end]?.parallelGroup === step.parallelGroup) end++;
      const batch = steps.slice(index, end),
        entries = batchEntries(flow, batch, runs);
      if (
        request.action === 'retry' &&
        step.kind === 'verify' &&
        entries[0].verificationStartedAt
      ) {
        const replacement = createEntry(flow, step, runs);
        entries[0] = replacement;
        flow.graph.batch[0] = replacement.runId;
      }
      if (flow.graph.recheck) {
        for (const [i, member] of batch.entries()) {
          if (!flow.graph.recheck.includes(member.id)) continue;
          entries[i] = createEntry(flow, member, runs);
          flow.graph.batch[i] = entries[i].runId;
        }
        delete flow.graph.recheck;
      }
      save(); // Persist all execution IDs before any branch may spawn a process.
      const jobs = batch.map((member, i) =>
        onlyAttempt && entries[i].executionId !== onlyAttempt
          ? undefined
          : executeEntry({
              flow,
              step: stepWithOverride(member, entries[i].routeOverride),
              entry: entries[i],
              runs,
              request,
              signal,
              observer,
              delegate,
              verify,
              waitForStop,
              recordStopping,
              persist: save,
            }),
      );
      onlyAttempt = undefined;
      const results = await Promise.allSettled(jobs);
      const crash = results.find((r) => r.status === 'rejected');
      if (crash) throw crash.reason;
      settleBatch(flow, batch, entries, steps);
      save();
      if (flow.status !== 'running') break;
    }

    return flow;
  } finally {
    if (cleanup)
      void cleanup()
        .catch((error) => console.warn('[SiliconHQ] 验证任务清理失败 · ' + error.message))
        .finally(unlock);
    else unlock();
  }
}
