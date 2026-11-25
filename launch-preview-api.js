import { catalogTemplates, launchConfig } from './workflow-catalog.js';
import { projectDocuments } from './project-documents.js';
import { attachDiff, chatSources, contextReference, reportSources } from './workflow-handoff.js';
import {
  agentName,
  describeExecutor,
  verificationSteps,
  builtinSequenceSummary,
  sequenceSummary,
} from './dist/workflow/rules.js';
import { preflightWorkflow } from './workflow-preflight.js';
import { describeRun, runStep } from './run-results.js';
import { scopedFlowForAgent, assertScope, ensureAgentWorkspace } from './dsh-workspace.js';
import { WorkflowStore } from './dist/storage/workflows.js';
import { RunStore } from './dist/storage/runs.js';
import { sameProjectDirectory } from './dist/storage/project-path.js';
import { inspectTrackedDiff } from './workflow-git.js';
import { hasActiveWorkflowJob, resolveStartPlan } from './native.js';
import { randomUUID } from 'node:crypto';

export function registerLaunchPreviews(ctx, config, endpoint, trials) {
  async function publishPreview(trial, plan, flow, signal) {
    const now = Date.now();
    for (const [key, entry] of trials)
      if (key !== trial.replaces && !entry.submitting && entry.expiry <= now) trials.delete(key);
    const preflight = await preflightWorkflow(ctx, plan, trial.cwd, {
      signal,
      onBaseline(baseline) {
        trial.diff = baseline;
      },
    });
    const diffRequired = !!plan.template?.includeDiff;
    const routes = plan.template?.steps ?? Object.values(plan.roles);
    const inheritsParentHistory = routes.some(
      (route) => ctx.get('subagents')?.getProvider(route.backend)?.inheritsParentContext === true,
    );
    const previous = trial.replaces && trials.get(trial.replaces);
    if (trial.replaces !== undefined) {
      if (
        !previous ||
        previous.sessionId !== trial.sessionId ||
        previous.receipt ||
        previous.submitting ||
        previous.superseded ||
        previous.selected !== trial.selected ||
        previous.flowId !== trial.flowId
      )
        throw Object.assign(
          new Error(
            '原预览已提交、已过期或已变更，请查看本会话运行记录。确认需要新建任务后，可重新打开 /sihq。',
          ),
          { code: 'sihq/preview-unavailable' },
        );
      previous.superseded = true;
    }
    const token = randomUUID();
    trials.set(
      token,
      Object.assign(trial, {
        requestId: previous?.requestId ?? token,
        diffRequired,
        preflight,
        expiry: Date.now() + 30 * 60_000,
      }),
    );
    return {
      token,
      flow: {
        ...flow,
        preflight,
        inheritsParentHistory,
        verificationSteps: verificationSteps(plan.template?.steps ?? []),
      },
      cwd: trial.cwd,
      diffRequired,
    };
  }
  async function prepareLaunch({ sessionId, selected, draft, replaces }, signal) {
    const cwd = await ensureAgentWorkspace(ctx, ctx.get('agents')?.get(sessionId), signal);
    const frozen = launchConfig(config, selected, draft);
    const flow = catalogTemplates(frozen).find((item) => item.id === selected);
    return publishPreview(
      { sessionId, cwd, selected, config: frozen, replaces },
      resolveStartPlan(frozen, sessionId, selected),
      flow,
      signal,
    );
  }
  endpoint('prepareContinuation', async ({ sessionId, id, replaces }, signal) => {
    const agent = ctx.get('agents')?.get(sessionId);
    const cwd = await ensureAgentWorkspace(ctx, agent, signal);
    const store = new WorkflowStore();
    const saved = scopedFlowForAgent(agent, id, store, cwd);
    if (
      !saved.dsh ||
      !describeRun(saved, undefined, undefined, { store, active: hasActiveWorkflowJob(id) })
        .canContinue
    )
      throw new Error('当前运行无法开始下一轮');
    const { template, roles } = saved.dsh;
    const describeRoute = (route) =>
      [
        route.instanceName || agentName(route.baseBackend || route.backend),
        route.model,
        route.reasoningEffort,
        route.agentPreset,
      ]
        .filter(Boolean)
        .join(' · ');
    const flow = {
      name: template?.name ?? 'SiliconHQ 开发流程',
      summary: template
        ? sequenceSummary(
            template.steps,
            (step) => step.name + ' · ' + describeExecutor(step, describeRoute),
          )
        : builtinSequenceSummary(
            (role) => describeRoute(roles[role] || roles.developer),
            saved.maxRepairs,
          ),
      canInheritReports: !template,
      rules: '沿用原流程的步骤和执行者。可勾选要交给下一轮的上轮报告。',
    };
    return publishPreview(
      { sessionId, cwd, config, flowId: id, round: saved.round ?? 1, replaces },
      saved.dsh,
      flow,
      signal,
    );
  });
  async function contextTrial(sessionId, token) {
    const trial = trials.get(token);
    if (
      !trial ||
      trial.sessionId !== sessionId ||
      trial.receipt ||
      trial.superseded ||
      trial.submitting ||
      Date.now() >= trial.expiry
    )
      throw new Error('上下文预览已过期，请重新选择流程');
    const agent = ctx.get('agents')?.get(sessionId);
    const cwd = await ensureAgentWorkspace(ctx, agent);
    if (!sameProjectDirectory(cwd, trial.cwd)) throw new Error('会话工作目录已改变，请重新预览');
    return { trial, agent, cwd };
  }
  endpoint('projectDocuments', async ({ sessionId, token, ...request }, signal) => {
    const { trial, agent } = await contextTrial(sessionId, token);
    return projectDocuments(ctx, agent, trial, request, signal);
  });
  endpoint('contextReference', async ({ sessionId, token, id }) => {
    const { trial } = await contextTrial(sessionId, token);
    return contextReference(trial, id);
  });
  endpoint('contextSources', async ({ sessionId, token, includeDiff, compact }) => {
    const { trial, agent, cwd } = await contextTrial(sessionId, token);
    if (!trial.candidates) {
      const store = new WorkflowStore();
      const id = trial.flowId ?? store.listPage(cwd, { session: sessionId, limit: 1 }).items[0]?.id;
      let reports = [];
      if (id) {
        const { flow } = store.readProgress(id, 0);
        assertScope(flow, sessionId, cwd);
        const round = flow.round ?? 1;
        if (trial.flowId && round !== trial.round) throw new Error('轮次已更新，请重新预览');
        if (flow.dsh?.session === sessionId)
          reports = reportSources(describeRun(flow, undefined), async (expected, index) => {
            const step = await runStep(
              ctx,
              { sessionId, id, round, index },
              store,
              new RunStore(),
              false,
            );
            if (
              !step.report ||
              step.runId !== expected.runId ||
              step.executionId !== expected.executionId
            )
              throw new Error(step.reportError || '报告已变更，请重新预览');
            return JSON.stringify(step.report, null, 2);
          });
      }
      trial.candidates = [...chatSources(agent.session), ...reports];
      trial.sources = [];
    }
    if (includeDiff === true || trial.diffRequired) await attachDiff(trial, inspectTrackedDiff);
    const refs = [...trial.candidates, ...(trial.diff ? [trial.diff] : [])];
    return {
      items:
        compact === true
          ? refs.map(({ kind, id, label }) => ({ kind, id, label }))
          : await Promise.all(refs.map((ref) => contextReference(trial, ref.id))),
      diffRequired: trial.diffRequired,
      diffError: trial.diffError,
    };
  });
  endpoint('commandReceipt', ({ sessionId, seq }) => {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new Error('无效的指令回执');
    const event = ctx.get('agents')?.get(sessionId)?.session?.eventAt(seq);
    if (
      event?.type !== 'sihq/launch' ||
      (event.data.sessionId && event.data.sessionId !== sessionId)
    )
      throw new Error('本会话没有该启动回执');
    return event.data;
  });
  endpoint('launchReceipt', async ({ sessionId, token }) => {
    const entry = trials.get(token);
    if (!entry?.receipt || entry.sessionId !== sessionId || Date.now() > entry.expiry) {
      const session = ctx.get('agents')?.get(sessionId)?.session;
      const events = session?.snapshotEvents?.() ?? session?.events ?? [];
      const saved =
        typeof token === 'string' &&
        events.findLast(
          (event) =>
            event.type === 'sihq/launch' &&
            event.data?.sessionId === sessionId &&
            [event.data.jobId, event.data.requestId, event.data.previewToken].includes(token),
        )?.data;
      if (!saved) throw new Error('请从本会话的运行记录查看已提交的任务。');
      return {
        jobId: saved.jobId,
        ...(!saved.flowId && !saved.error && { historyOnly: true }),
        ...(saved.flowId && { flowId: saved.flowId }),
        ...(saved.error && { error: saved.error }),
      };
    }
    if (!entry.receipt.flowId && !entry.receipt.error) {
      // A host may schedule its producer after acknowledging the command.
      let timer;
      try {
        await Promise.race([
          entry.ready,
          new Promise((resolve) => {
            timer = setTimeout(resolve, 1500);
          }),
        ]);
      } finally {
        clearTimeout(timer);
      }
    }
    return entry.receipt;
  });
  endpoint('prepareLaunch', prepareLaunch);
  endpoint('prepareTrial', async (payload, signal) => (await prepareLaunch(payload, signal)).token);
}
