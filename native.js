import { withActivation } from './cancellation.js';
import { isDeepStrictEqual } from 'node:util';
import { assertWorkflowCommand, recoveryView } from './workflow-control.js';
import { liveChildRoute } from './child-route.js';
import { checkedRoute, routeFor } from './agent-routing.js';
import { reassignAttempt, retryAttempts, resolveReassignment } from './workflow-reassignment.js';
import { readonlyCodex } from './codex-backend.js';
export { codexModelCatalog, readonlyCodex, registerReadonlyCodex } from './codex-backend.js';
export { routeFor } from './agent-routing.js';
import { promptWithHandoff, recordStepInput } from './workflow-handoff.js';
import { describeRun, formatRunResult } from './run-results.js';
import { agentWorkspace, scopedFlowForAgent } from './dsh-workspace.js';
import { startWithCapacity } from './admission.js';
import { instancesOf, resolveRoute, routeLabel } from './agent-instances.js';
import { runTemplate } from './template-runner.js';
import { baselineSource, trackedDiff } from './workflow-git.js';
import { checkGateReturn } from './approval-return.js';
import { diffReview, selectedWorkflowTemplate } from './workflow-templates.js';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executeTask } from './dist/execution/tasks.js';
import { getRoleDefinition } from './dist/roles/index.js';
import { atomicJson } from './dist/storage/files.js';
import { RunStore } from './dist/storage/runs.js';
import { WorkflowStore } from './dist/storage/workflows.js';
import { continueWorkflow, resumeWorkflow, runWorkflow } from './dist/workflow/runner.js';

import { isAgentStep, roles } from './dist/workflow/rules.js';
import { executeVerification, stopVerificationJob } from './verification-command.js';
export { roles };
const message = (error) => (error instanceof Error ? error.message : String(error));
import { setting } from './profile-config.js';
export { setting } from './profile-config.js';

export function routing(config, session) {
  const routes = {};
  const instances = instancesOf(config);
  for (const role of [...roles, 'feedback']) {
    const backend = setting(config, role, 'spawn').trim();
    if (!backend) throw new Error(role + ' 缺少子 Agent provider 名称');
    const provider = setting(config, role + 'Llm', '').trim();
    const model = setting(config, role + 'Model', '').trim();
    const reasoningEffort = setting(config, role + 'ReasoningEffort', '').trim();
    routes[role] = resolveRoute(
      {
        backend,
        ...(provider && { provider }),
        ...(model && { model }),
        ...(reasoningEffort && { reasoningEffort }),
      },
      instances,
    );
  }
  const policy = setting(config, 'reviewPolicy', 'strict');
  if (!['strict', 'blocking'].includes(policy)) throw new Error('未知审查策略');
  return { session, roles: routes, ...(policy === 'blocking' && { reviewPolicy: policy }) };
}

// DSH accepts the structural subset. The original Zod parser checks lengths,
// nonempty lists and semantic relationships after every activation.
export function hostSchema(schema) {
  const { $schema, minLength, minItems, properties, items, ...rest } = schema;
  if (properties)
    rest.properties = Object.fromEntries(
      Object.entries(properties).map(([key, value]) => [key, hostSchema(value)]),
    );
  if (items) rest.items = hostSchema(items);
  return rest;
}
export function reportText(result) {
  const text = (result.output ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  if (result.stopReason !== 'completed')
    throw new Error(
      [text, result.diagnostic].filter(Boolean).join('\n') ||
        '子 Agent 结束状态 ' + result.stopReason,
    );
  if (result.structured !== undefined) return JSON.stringify(result.structured);
  return text.match(/^\x60{3}(?:json)?\s*\n([\s\S]*?)\n\x60{3}$/i)?.[1] ?? text;
}
function previousReport(store, run, repairSource) {
  const id = repairSource?.runId ?? run.sourceRunId ?? run.id;
  const source = id === run.id ? run : store.read(id);
  const file = join(
    store.directory(id),
    getRoleDefinition(source.role, source.purpose).artifactName,
  );
  let text;
  if (repairSource?.executionId) {
    const receipt = join(store.directory(id), 'dsh-' + repairSource.executionId + '.json');
    if (existsSync(receipt)) {
      const saved = JSON.parse(readFileSync(receipt, 'utf8'));
      if (saved.state === 'answered') text = saved.answer;
    }
  }
  if (!text && existsSync(file)) text = readFileSync(file, 'utf8');
  if (!text) {
    if (repairSource) throw new Error('缺少本轮被退回的开发报告，请检查阶段记录');
    return;
  }
  const label = repairSource ? '本轮被退回的开发报告' : '上次阶段报告（仅作历史资料）';
  return { text, label, kind: 'report', id: repairSource?.executionId ?? id };
}
export function activationPrompt(prompt, schema, structured) {
  return structured
    ? prompt
    : prompt + '\n最终答复只输出满足以下 JSON Schema 的 JSON 对象。\n' + JSON.stringify(schema);
}
async function activate({
  handoff,
  inputSources = /** @type {{ id: string, kind: string, label: string }[]} */ ([]),
  cwd,
  ctx,
  service,
  parent,
  route,
  readOnly,
  directory,
  executionId,
  workflowId,
  label,
  prompt,
  active,
  schema,
  onChild,
  onWaiting,
}) {
  const file = join(directory, 'dsh-' + executionId + '.json');
  const prior = existsSync(file) && JSON.parse(readFileSync(file, 'utf8'));
  // The receipt can survive a crash between admission and the workflow checkpoint.
  if (prior?.childId && ['submitted', 'answered'].includes(prior.state)) onChild(prior.childId);
  if (prior?.state === 'answered') {
    return prior.answer;
  }
  if (prior && prior.state !== 'waiting_capacity')
    throw new Error(
      '上次委派没有可复用报告。请核对工作树，再显式运行 /sihq workflow retry ' + workflowId,
    );
  let submittedProvider, input;
  const handle = await startWithCapacity({
    ctx,
    service,
    receiptFile: file,
    onWaiting,
    request: { cwd, parent, label, signal: active, delivery: 'caller' },
    prepare: async (request) => {
      const { spec } = await checkedRoute(ctx, service, route, readOnly, parent);
      request.signal.throwIfAborted();
      // Profile settings may change while the host resolves a preset/model.
      if (!isDeepStrictEqual(spec, routeFor(service, route, readOnly, ctx, parent)))
        throw new Error('等待校验时后端配置已变化，请刷新后恢复。');
      const structured = !!service.getProvider(spec.provider).capabilities.outputSchema;
      if (input && structured !== input.structured)
        throw new Error('后端的报告能力已变化，请重新确认步骤后恢复。');
      if (!input) {
        input = {
          prompt: activationPrompt(promptWithHandoff(prompt, handoff), schema, structured),
          structured,
          outputSchema: structured ? hostSchema(schema) : schema,
          sources: [
            ...inputSources,
            ...(handoff ?? []).map(({ id, kind, label }) => ({ id, kind, label })),
          ],
        };
        recordStepInput(directory, executionId, input);
      }
      submittedProvider = spec.provider;
      return {
        ...request,
        ...spec,
        prompt: [{ type: 'text', text: input.prompt }],
        ...(structured && { outputSchema: input.outputSchema }),
      };
    },
  });
  return withActivation(handle, active, async () => {
    const resolvedRoute = liveChildRoute(ctx, handle.childId, parent.id, submittedProvider);
    atomicJson(file, { state: 'submitted', childId: handle.childId, resolvedRoute });
    onChild(handle.childId);
    const result = await handle.result;
    const answer = reportText(result);
    active.throwIfAborted();
    const observedModel =
      route.backend === readonlyCodex
        ? result.diagnostic?.match(/^Codex CLI model: ([\w.:/+-]+)$/)?.[1]
        : undefined;
    atomicJson(file, {
      state: 'answered',
      answer,
      childId: handle.childId,
      observedModel,
      resolvedRoute,
    });
    return answer;
  });
}
function nativeExecutor(service, parent, cwd, routes, ctx, handoff) {
  return async (
    store,
    run,
    instruction,
    signal,
    executionId,
    observer,
    routeOverride,
    repairSource,
  ) => {
    const route =
      routeOverride ??
      (run.purpose === 'developer_feedback'
        ? (routes.feedback ?? routes.developer)
        : routes[run.role]);
    run.dshProvider = route.baseBackend ?? route.backend;
    observer?.onDispatch?.(run);
    observer?.log('[委派] ' + (run.purpose ?? run.role) + ' → ' + routeLabel(route));
    if (route.model) run.model = route.model;
    else delete run.model;
    return executeTask(
      store,
      run,
      instruction,
      signal,
      executionId,
      observer,
      async (prompt, active, options) => {
        const previous = previousReport(store, run, repairSource);
        return activate({
          ctx,
          onWaiting: () => observer?.onWaiting?.(run.purpose ?? run.role),
          cwd,
          service,
          parent,
          route,
          readOnly: getRoleDefinition(run.role, run.purpose).sandboxMode === 'read-only',
          directory: store.directory(run.id),
          executionId,
          workflowId: run.workflowId,
          label: run.purpose ?? run.role,
          prompt: previous ? prompt + '\n' + previous.label + '\n' + previous.text : prompt,
          inputSources: previous
            ? [{ id: previous.id, kind: previous.kind, label: previous.label }]
            : [],
          handoff,
          active,
          schema: options.outputSchema,
          onChild: (childId) => {
            observer?.onAccepted?.();
            options.onEvent?.({ type: 'thread.started', thread_id: childId });
            observer?.onDispatch?.(run);
          },
        });
      },
    );
  };
}

// Jobs may acknowledge a submission before their producer obtains the durable workflow lock.
const activeJobs = new Map();
export function hasActiveWorkflowJob(id) {
  return activeJobs.has(id);
}

export function resolveStartPlan(
  config,
  session,
  selected = setting(config, 'selectedTemplate', 'siliconhq').trim(),
) {
  if (selected === 'siliconhq') return routing(config, session);
  const template = selectedWorkflowTemplate(setting(config, 'templates', [diffReview]), selected);
  if (!template) throw new Error('找不到所选工作流 ' + selected);
  const instances = instancesOf(config);
  const steps = template.steps.map((step) => resolveRoute(step, instances));
  return { session, template: { ...template, steps } };
}

export function submitWorkflow(ctx, config, parent, request, flags, controllers, stores = {}) {
  const flows = stores.flows ?? new WorkflowStore();
  const runs = stores.runs ?? new RunStore();
  const cwd = flags.cwd ?? agentWorkspace(parent, ctx);
  const old =
    request.action === 'start' ? undefined : scopedFlowForAgent(parent, request.id, flows, cwd);
  if (old && !old.dsh) return undefined; // Legacy CLI records belong to their original workspace.
  if (old && ['retry', 'resume'].includes(request.action)) {
    request = { ...request, expectedState: request.expectedState ?? recoveryView(old).token };
  }
  if (old && hasActiveWorkflowJob(old.id)) throw new Error('该流程已有 DSH 后台任务正在执行。');
  const service = ctx.get('subagents');
  const jobs = ctx.get('jobs');
  if (!jobs) throw new Error('此 profile 需要 DSH 的 jobs 服务。');
  if (old) assertWorkflowCommand(old, request);
  if (request.action === 'return') checkGateReturn(old, old.pendingApproval, request);
  if (flags.speed) throw new Error('原生工作流的速度和推理设置由 DSH 或外部 provider 管理。');
  let frozen = old?.dsh ?? flags.startPlan ?? resolveStartPlan(config, parent.id, request.template);
  if (request.action === 'start' || request.action === 'continue') {
    const { handoff: previousHandoff, ...routes } = frozen;
    let handoff = request.handoff;
    if (routes.template?.includeDiff && !handoff?.some((source) => source.id === 'git-diff'))
      handoff = [...(handoff ?? []), baselineSource(trackedDiff(cwd))];
    frozen = handoff === undefined ? routes : { ...routes, handoff };
  }
  const template = frozen.template;
  if (request.inheritReports && (template || request.action !== 'continue'))
    throw new Error('自动继承角色报告只适用于内置流程的续轮，自定义流程可选择具体报告');
  // Commands have preflighted the frozen plan. Direct callers still validate routes at admission.
  if (!old && !flags.startPlan) {
    if (template) {
      for (const step of template.steps)
        if (isAgentStep(step)) routeFor(service, step, step.kind !== 'develop', ctx);
    } else {
      for (const [role, route] of Object.entries(frozen.roles)) {
        routeFor(service, route, role !== 'developer', ctx);
      }
    }
  }
  const replacement =
    request.action === 'reassign' ? resolveReassignment(config, old, request) : undefined;
  if (replacement) routeFor(service, replacement.route, replacement.readOnly, ctx);
  const deps = {
    flows,
    runs,
    dsh: frozen,
    expectedRound: request.expectedRound,
    inheritReports: request.inheritReports === true,
    beforeResume(flow) {
      assertWorkflowCommand(flow, request);
      if (request.action === 'retry') retryAttempts(flow, runs);
      if (replacement) reassignAttempt(flow, request, replacement.route, runs);
    },
    executeTask: nativeExecutor(service, parent, cwd, frozen.roles, ctx, frozen.handoff),
  };
  const repairs = flags.explicitBudget ? request.maxRepairs : setting(config, 'maxRepairs', 2);
  const receipt = { flowId: old?.id };
  const ready = Promise.withResolvers();
  flags.signal?.throwIfAborted();
  const jobId = jobs.start({
    kind: 'workflow',
    label:
      (template?.name ?? 'SiliconHQ') + ' · ' + (request.prompt ?? request.action).slice(0, 64),
    owner: parent.id,
    run(job) {
      const controller = new AbortController();
      controllers.add(controller);
      const stages = new Map();
      const observer = {
        log: (line) => job.append(line + '\n', { channel: 'log' }),
        renderEvent() {},
        onStage(stage, run) {
          stages.set(run.id, stage);
          job.updateProgress(stage + ' · ' + run.id);
        },
        onDispatch(run, stage = stages.get(run.id)) {
          job.updateProgress(stage + ' · ' + run.dshProvider + ' · ' + run.id);
        },
        onWaiting(label) {
          const message = label + ' · 等待 DSH 子 Agent 名额';
          job.updateProgress(message);
          job.append(message + '\n', { channel: 'log' });
        },
        onUpdate(flow) {
          receipt.flowId = flow.id;
          activeJobs.set(flow.id, receipt);
          ready.resolve(undefined);
        },
      };
      const work = template
        ? runTemplate({
            request,
            replacement: replacement?.route,
            flows,
            runs,
            cwd,
            frozen,
            observer,
            signal: controller.signal,
            globalBudget: repairs,
            stopJob: (id) => stopVerificationJob(ctx, parent, id),
            verify: (command, directory, signal, onStopping, waitForStop) =>
              executeVerification(ctx, parent, directory, command, signal, onStopping, waitForStop),
            delegate: (step, args) =>
              activate({
                ...args,
                handoff: frozen.handoff,
                ctx,
                cwd,
                service,
                parent,
                route: step,
                readOnly: step.kind !== 'develop',
              }),
          })
        : request.action === 'start'
          ? runWorkflow(request.prompt, cwd, controller.signal, repairs, observer, undefined, deps)
          : request.action === 'continue'
            ? continueWorkflow(old.id, request.prompt, controller.signal, observer, undefined, deps)
            : resumeWorkflow(old.id, controller.signal, observer, undefined, deps);
      const done = work
        .then((flow) => {
          const detail = formatRunResult(describeRun(flow, runs));
          job.append(detail + '\n', { channel: 'log' });
          if (flow.status === 'cancelled') return { status: 'killed', detail };
          return ['completed', 'passed', 'waiting_approval', 'rejected'].includes(flow.status)
            ? { status: 'completed', detail, result: detail }
            : { status: 'failed', detail };
        })
        .catch((error) => {
          const detail = message(error);
          if (!receipt.flowId) receipt.error = detail;
          return { status: controller.signal.aborted ? 'killed' : 'failed', detail };
        })
        .finally(() => {
          ready.resolve(undefined);
          if (activeJobs.get(receipt.flowId) === receipt) activeJobs.delete(receipt.flowId);
          controllers.delete(controller);
        });
      return { cancel: (reason) => controller.abort(reason), done };
    },
  });
  receipt.jobId = jobId;
  if (receipt.flowId) activeJobs.set(receipt.flowId, receipt);
  flags.onStarted?.(receipt, ready.promise);
  let sourceEventSeq;
  try {
    sourceEventSeq = parent.session?.append?.('sihq/launch', {
      jobId,
      ...(receipt.flowId && { flowId: receipt.flowId }),
    })?.seq;
  } catch (error) {
    ctx.logger?.warn?.('无法保存 SiliconHQ 启动回执：' + message(error));
  }
  return {
    ...(Number.isSafeInteger(sourceEventSeq) && { sourceEventSeq }),
    kind: 'success',
    text:
      (template?.name ?? 'SiliconHQ') +
      ' 已启动\nDSH 后台任务 ' +
      jobId +
      (receipt.flowId
        ? '\n流程 ' + receipt.flowId + '\n/sihq workflow status ' + receipt.flowId
        : '') +
      '\n可在 Jobs 中查看阶段和日志，或取消任务。',
  };
}
