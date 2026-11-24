import { whileActive } from './cancellation.js';
import {
  templateEntries,
  catalogTemplates,
  availableProviders,
  resolveTemplate,
  launchConfig,
} from './workflow-catalog.js';
export { Config, availableProviders, resolveTemplate } from './workflow-catalog.js';
import { projectDocuments } from './project-documents.js';
import {
  attachDiff,
  chatSources,
  contextReference,
  reportSources,
  selectHandoff,
} from './workflow-handoff.js';
import { reassignmentOptions, resolveReassignment } from './workflow-reassignment.js';
import { checkedRoute } from './agent-routing.js';
import { observeProviderNames } from './provider-discovery.js';
import {
  agentName,
  describeExecutor,
  verificationSteps,
  builtinSequenceSummary,
  sequenceSummary,
} from './dist/workflow/rules.js';
import { preflightWorkflow, assertPreflight } from './workflow-preflight.js';
import { exportWorkflow, inspectImport, prepareImport } from './workflow-portable.js';
import { describeRun, runApprovalContext, runProgress, runStep } from './run-results.js';
import {
  scopedFlow,
  scopedFlowForAgent,
  assertScope,
  ensureAgentWorkspace,
  sessionWorkspace,
} from './dsh-workspace.js';
import { WorkflowStore } from './dist/storage/workflows.js';
import { RunStore } from './dist/storage/runs.js';
import { runProgressQuery } from './dist/storage/workflow-progress.js';
import { sameProjectDirectory } from './dist/storage/project-path.js';
import { checkInstance, modelChoices } from './instance-health.js';
import { listPresetOptions, readonlyPreset } from './preset-options.js';
import {
  routeLabel,
  resolveRoute,
  inspectInstances,
  instanceRows,
  instancesOf,
  validateInstanceRepair,
  productEntries,
  registerProductBridge,
} from './agent-instances.js';
import { previewStepInput } from './step-prompt.js';
import { inspectTrackedDiff } from './workflow-git.js';
import { installReadonlyGuard } from './readonly.js';
import { inspectTemplates } from './workflow-templates.js';
import {
  roles,
  routeFor,
  registerReadonlyCodex,
  activationPrompt,
  hostSchema,
  routing,
  hasActiveWorkflowJob,
  submitWorkflow,
  resolveStartPlan,
} from './native.js';
import { randomUUID } from 'node:crypto';
import { argumentsOf, commandHelp, executeCompatCommand } from './compat-command.js';
import { parseCommand } from './dist/commands/parse.js';

export const name = 'dsh-sihq';
export const inject = ['commands'];
function historyPage(store, cwd, sessionId, offset = 0, limit = 25) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('请打开目标 DSH 会话后查询。');
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error('历史分页参数无效');
  return store.listPage(cwd, { session: sessionId, offset, limit });
}

async function submitInSession(ctx, config, agent, request, flags, controllers) {
  let plan;
  if (request.action === 'start') {
    plan = resolveStartPlan(config, agent.id, request.template);
    flags = { ...flags, startPlan: plan };
  } else if (request.action === 'continue') {
    const saved = scopedFlowForAgent(agent, request.id, new WorkflowStore(), flags.cwd);
    plan = saved.dsh;
  }
  if (plan) {
    const report = await preflightWorkflow(ctx, plan, flags.cwd, {
      signal: flags.signal,
      baselineReady: request.handoff?.some((ref) => ref.id === 'git-diff'),
      onBaseline(baseline) {
        request = { ...request, handoff: [...(request.handoff ?? []), baseline] };
      },
    });
    assertPreflight(report);
  }
  return submitWorkflow(ctx, config, agent, request, flags, controllers);
}

async function execute(
  ctx,
  config,
  controllers,
  trials,
  { rawInput, agent, signal },
  knownProviderNames,
) {
  try {
    const input = rawInput.trim();
    if (!input)
      return {
        kind: 'success',
        text:
          catalogTemplates(config)
            .map((t) => t.name + (t.active ? '（默认）' : '') + ' · ' + t.summary)
            .join('\n') + '\n/sihq run "流程名" "任务"  ·  /sihq workflow "默认流程任务"',
      };
    if (['help', '--help'].includes(input)) return { kind: 'success', text: commandHelp };
    const args = argumentsOf(input);
    if (args.length === 1 && args[0] === 'providers') {
      const current = routing(config, agent.id);
      const service = ctx.get('subagents');
      const installed = availableProviders(
        service,
        config,
        knownProviderNames(service),
        productEntries(ctx),
      );
      const names = new Set([
        ...installed.map((p) => p.name),
        ...Object.values(current.roles).map((r) => r.backend),
      ]);
      const lines = [...names].map(
        (key) => key + ' · ' + (service?.getProvider(key) ? '已注册' : '未注册'),
      );
      return {
        kind: 'success',
        text: [
          ...roles.map((role) => role + ' → ' + routeLabel(current.roles[role])),
          '',
          ...lines,
        ].join('\n'),
      };
    }
    if (args.join(' ') === 'workflow templates')
      return {
        kind: 'success',
        text: [
          'siliconhq · SiliconHQ',
          ...templateEntries(config).map(
            (t) => t.id + ' · ' + t.name + (t.diagnostic ? '（需修复：' + t.diagnostic + '）' : ''),
          ),
        ].join('\n'),
      };
    const cwd = await ensureAgentWorkspace(ctx, agent, signal);
    const submit = (config, request, flags) =>
      submitInSession(ctx, config, agent, request, { ...flags, signal }, controllers);
    function trackDirectLaunch(receipt, ready) {
      if (receipt.flowId) return;
      const now = Date.now();
      for (const [key, entry] of trials) if (entry.expiry <= now) trials.delete(key);
      trials.set(receipt.jobId, { sessionId: agent.id, expiry: now + 60_000, receipt, ready });
    }
    if (args[0] === 'workflow' && args[1] === '--template') {
      const [, , template, task, flag, limit] = args;
      const explicitBudget = args.length === 6 && flag === '--max-repairs' && /^[012]$/.test(limit);
      if (!template || !task?.trim() || (args.length !== 4 && !explicitBudget))
        throw new Error('用法：/sihq workflow --template <模板 ID> "需求" [--max-repairs 0|1|2]');
      signal?.throwIfAborted();
      return await submit(
        config,
        {
          action: 'start',
          template,
          prompt: task.trim(),
          ...(explicitBudget && { maxRepairs: Number(limit) }),
        },
        { cwd, explicitBudget, onStarted: trackDirectLaunch },
      );
    }
    if (['try', 'launch'].includes(args[0]) && [3, 4, 5].includes(args.length)) {
      const trial = trials.get(args[1]);
      if (!trial || trial.receipt || trial.sessionId !== agent.id || Date.now() > trial.expiry)
        throw new Error('启动预览已过期，请重新从 /sihq 选择流程。');
      if (!sameProjectDirectory(cwd, trial.cwd))
        throw new Error('会话工作目录已改变，请重新预览。');
      if (trial.submitting) throw new Error('启动请求正在提交，请勿重复发送。');
      if (args.length === 5 && (!trial.flowId || args[4] !== '--inherit-reports'))
        throw new Error('无效的续轮选项');
      assertPreflight(trial.preflight);
      const prompt = args[2].trim();
      if (!prompt) throw new Error('请填写任务内容');
      signal?.throwIfAborted();
      trial.submitting = true;
      try {
        const result = await submit(
          trial.config,
          trial.flowId
            ? {
                action: 'continue',
                id: trial.flowId,
                prompt,
                expectedRound: trial.round,
                inheritReports: args[4] === '--inherit-reports',
                handoff: selectHandoff(trial, args[3]),
              }
            : {
                action: 'start',
                template: trial.selected,
                prompt,
                handoff: selectHandoff(trial, args[3]),
              },
          {
            cwd: trial.cwd,
            onStarted(receipt, ready) {
              trials.set(args[1], {
                sessionId: agent.id,
                expiry: Date.now() + 60_000,
                receipt,
                ready,
              });
            },
          },
        );
        if (args[0] === 'try') trials.delete(args[1]);
        return result;
      } finally {
        trial.submitting = false;
      }
    }
    if (
      args[0] === 'run' &&
      args.length > 2 &&
      !['--', '--fast', '--no-fast'].includes(args[1]) &&
      args.slice(2).some((v) => ['--', '--fast', '--no-fast'].includes(v)) &&
      catalogTemplates(config).some((t) => t.id === args[1] || t.name === args[1])
    ) {
      throw new Error(
        '指令同时匹配命名工作流和单任务。运行工作流请用 /sihq workflow --template <模板 ID> "任务"；运行单任务请用 /sihq run [--fast|--no-fast] -- "任务"。',
      );
    }
    if (
      args[0] === 'run' &&
      args.length > 2 &&
      !args.some((a) => ['--', '--fast', '--no-fast'].includes(a))
    ) {
      const template = resolveTemplate(catalogTemplates(config), args[1]);
      const prompt = args.slice(2).join(' ').trim();
      if (!prompt) throw new Error('请填写任务内容');
      signal?.throwIfAborted();
      return await submit(
        config,
        { action: 'start', template, prompt },
        { cwd, onStarted: trackDirectLaunch },
      );
    }
    if (args[0] === 'workflow' && args[1] === 'list') {
      if (args.length !== 2 && !(args.length === 4 && args[2] === '--offset'))
        throw new Error('用法：/sihq workflow list [--offset N]');
      const page = historyPage(
        new WorkflowStore(),
        cwd,
        agent.id,
        args[3] === undefined ? 0 : Number(args[3]),
      );
      const lines = page.items.map((f) =>
        [f.id, f.status, f.stage, JSON.stringify(f.prompt)].join('  '),
      );
      if (page.nextOffset !== null) lines.push('/sihq workflow list --offset ' + page.nextOffset);
      return { kind: 'success', text: lines.join('\n') || '本会话暂无 SiliconHQ 运行记录。' };
    }
    if (args[0] === 'workflow' && args[1] === 'status' && args.length === 3) {
      const flow = scopedFlowForAgent(agent, args[2], new WorkflowStore(), cwd, false);
      // Keep the existing JSON response for saved commands. The UI uses the typed detail RPC.
      return { kind: 'success', text: JSON.stringify(flow, null, 2) };
    }
    if (args[0] === 'workflow' && ['approve', 'reject', 'return'].includes(args[1])) {
      if (args.length < 4) throw new Error('请在运行详情中确认或拒绝当前等待的步骤。');
      if (args[1] === 'return' && args.length < 6)
        throw new Error('用法：/sihq workflow return <流程 ID> <确认 ID> <目标步骤 ID> "退回理由"');
      const [, action, id, approvalId, ...note] = args;
      const target = action === 'return' ? note.shift() : undefined;
      const result = await submit(
        config,
        { action, id, approvalId, target, note: note.join(' ') },
        { cwd },
      );
      if (!result) throw new Error('该流程没有人工确认步骤。');
      return result;
    }
    const retry = args[0] === 'workflow' && args[1] === 'retry';
    if (args[0] === 'workflow' && args[1] === 'reassign') {
      if (![6, 7].includes(args.length) || args[5] !== '--confirm') {
        throw new Error(
          '用法：/sihq workflow reassign <流程 ID> <失败尝试 ID> <目标命名实例 ID> --confirm',
        );
      }
      const [, , id, executionId, instanceId, , revision] = args;
      const request = {
        action: 'reassign',
        id,
        executionId,
        instanceId,
        confirmed: true,
        revision,
      };
      const old = scopedFlowForAgent(agent, id, new WorkflowStore(), cwd);
      const replacement = resolveReassignment(config, old, request);
      await whileActive(
        checkedRoute(ctx, ctx.get('subagents'), replacement.route, replacement.readOnly, agent),
        signal,
      );
      signal?.throwIfAborted();
      return submitWorkflow(
        ctx,
        config,
        agent,
        { ...request, revision: replacement.revision },
        { cwd, signal },
        controllers,
      );
    }
    const recovery = retry || (args[0] === 'workflow' && args[1] === 'resume');
    let expectedState;
    if (
      recovery &&
      args.length === 5 &&
      args[3] === '--if-current' &&
      /^[a-f0-9]{64}$/.test(args[4])
    ) {
      expectedState = args[4];
      args.splice(3);
    }
    if ((retry || (recovery && args[3] === '--if-current')) && args.length !== 3)
      throw new Error('用法：/sihq workflow ' + args[1] + ' <流程 ID> [--if-current <状态标识>]');
    const inheritReports =
      args[0] === 'workflow' &&
      args[1] === 'continue' &&
      args.length >= 5 &&
      args[3] === '--inherit-reports';
    if (inheritReports) args.splice(3, 1);
    const parsed = parseCommand(retry ? ['workflow', 'resume', args[2]] : args, cwd);
    if (parsed.kind === 'workflow' && !['list', 'status'].includes(parsed.request.action)) {
      signal?.throwIfAborted();
      const request = {
        ...parsed.request,
        ...(retry && { action: 'retry' }),
        ...(expectedState && { expectedState }),
        ...(inheritReports && { inheritReports: true }),
      };
      const result = await submit(config, request, {
        cwd,
        explicitBudget: args.includes('--max-repairs'),
        speed: parsed.speed,
        onStarted: trackDirectLaunch,
      });
      if (result) return result;
      if (expectedState) throw new Error('旧版流程请在终端使用 workflow resume');
      if (retry) throw new Error('旧版流程请使用 workflow resume');
    }
    return await executeCompatCommand(parsed, args, cwd, signal);
  } catch (error) {
    return { kind: 'error', text: error instanceof Error ? error.message : String(error) };
  }
}

export function apply(ctx, config = {}) {
  const controllers = new Set();
  const trials = new Map();
  const knownProviderNames = observeProviderNames(ctx);
  ctx.inject?.(['connection'], (child) => {
    function endpoint(method, handle) {
      // DSH authenticates exact Fetch routes and admits only the owner on both Web and Desktop.
      child.connection.fetch.register({
        path: '/api/sihqCatalog/' + method,
        methods: ['POST'],
        requestBody: 'buffered',
        async fetch(request) {
          const { rpcId, payload } = await request.json();
          let result;
          try {
            result = { ok: true, value: await handle(payload, request.signal) };
          } catch (error) {
            result = {
              ok: false,
              error: {
                code: 'sihq/invalid',
                message: error.message,
                details: {},
              },
            };
          }
          return Response.json({ type: 'server-response', rpcId, result });
        },
      });
    }
    async function portableProviders() {
      const products = productEntries(ctx);
      let presets = [];
      let presetError;
      try {
        presets = await listPresetOptions(ctx);
      } catch (error) {
        presetError = error.message;
      }
      return availableProviders(
        ctx.get('subagents'),
        config,
        knownProviderNames(ctx.get('subagents')),
        products,
      ).map((p) => ({
        ...p,
        product: products.get(p.name)?.product,
        ...(p.agentPreset && { presets, ...(presetError && { presetError }) }),
        ...(p.agentPreset &&
          !presets.some((preset) => preset.id === readonlyPreset && !preset.broken) && {
            read: false,
            readRestriction: presetError || 'DSH 只读预设不可用',
          }),
      }));
    }
    endpoint('exportWorkflow', ({ id }) => exportWorkflow(config, id));
    endpoint('inspectImport', async ({ file, instanceChoices }) =>
      inspectImport(file, await portableProviders(), config, instanceChoices),
    );
    endpoint(
      'prepareImport',
      async ({ file, choices, syncBudget, clearOverrides, instanceChoices }) =>
        prepareImport(
          config,
          file,
          choices,
          await portableProviders(),
          syncBudget,
          clearOverrides,
          instanceChoices,
        ),
    );

    endpoint('validateInstanceRepair', ({ rows, index, value }) =>
      validateInstanceRepair(rows, index, value),
    );
    endpoint('validateTemplate', ({ template }) => {
      const row = inspectTemplates([template], {
        instanceIds: new Set(instancesOf(config).map((i) => i.id)),
      })[0];
      if (row.diagnostic) throw new Error(row.diagnostic);
      return row.template;
    });
    endpoint('validateRoles', (draft) => {
      routing(launchConfig(config, 'siliconhq', draft), undefined);
      return true;
    });
    /** @param {{inspectInstanceRows?: unknown[]}} [options] */
    function workflows({ inspectInstanceRows } = {}) {
      const entries = templateEntries(config);
      return {
        templates: catalogTemplates(config, entries),
        diagnostics: entries.filter((row) => row.diagnostic),
        ...(inspectInstanceRows && { instanceEntries: inspectInstances(inspectInstanceRows) }),
      };
    }
    endpoint('workflows', workflows);
    endpoint('providers', portableProviders);
    endpoint(
      'catalog',
      async ({ sessionId = undefined, inspectInstanceRows = undefined } = {}) => ({
        ...workflows({ inspectInstanceRows: inspectInstanceRows ?? instanceRows(config) }),
        providers: await portableProviders(),
        cwd: sessionId ? sessionWorkspace(ctx, sessionId) : undefined,
      }),
    );
    endpoint('previewStep', (payload) => {
      const service = ctx.get('subagents');
      const route = resolveRoute(payload.step, instancesOf(config));
      const spec = routeFor(service, route, payload.step.kind !== 'develop', ctx);
      const provider = service.getProvider(spec.provider);
      const structured = !!provider.capabilities.outputSchema;
      const { prompt, schema } = previewStepInput(payload);
      return {
        prompt: activationPrompt(prompt, schema, structured),
        structured,
        schema: structured ? hostSchema(schema) : schema,
      };
    });
    endpoint('modelChoices', (payload) => modelChoices(ctx, payload));
    const activeChecks = new Set();
    endpoint('instanceCheck', async (payload, signal) => {
      if (payload?.live !== true) return checkInstance(ctx, config, payload, signal);
      if (activeChecks.has(payload.id)) throw new Error('该实例正在执行实际委派测试');
      const controller = new AbortController();
      activeChecks.add(payload.id);
      controllers.add(controller);
      try {
        return await checkInstance(
          ctx,
          config,
          payload,
          AbortSignal.any([signal, controller.signal, AbortSignal.timeout(90000)]),
        );
      } finally {
        controllers.delete(controller);
        activeChecks.delete(payload.id);
      }
    });
    endpoint('runHistory', ({ sessionId, offset, limit }) =>
      historyPage(new WorkflowStore(), sessionWorkspace(ctx, sessionId), sessionId, offset, limit),
    );
    endpoint('runDetail', ({ sessionId, id, round }) => {
      const store = new WorkflowStore();
      const flow = scopedFlow(ctx, sessionId, id, store, false);
      return describeRun(flow, new RunStore(), round, { store, active: hasActiveWorkflowJob(id) });
    });
    endpoint('runProgress', (payload, signal) => {
      signal.throwIfAborted();
      const query = runProgressQuery.safeParse(payload);
      if (!query.success) throw new Error('运行进度查询参数无效，请重新打开运行详情。');
      return runProgress(ctx, query.data, new WorkflowStore(), hasActiveWorkflowJob(query.data.id));
    });
    endpoint('runStep', (payload) => runStep(ctx, payload, new WorkflowStore(), new RunStore()));
    endpoint('reassignmentOptions', ({ sessionId, id, executionId }) =>
      reassignmentOptions(
        ctx,
        config,
        scopedFlow(ctx, sessionId, id, new WorkflowStore()),
        executionId,
      ),
    );
    endpoint('runApprovalContext', (payload) =>
      runApprovalContext(ctx, payload, new WorkflowStore()),
    );
    async function publishPreview(trial, plan, flow, signal) {
      const now = Date.now();
      for (const [key, entry] of trials) if (entry.expiry <= now) trials.delete(key);
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
      const token = randomUUID();
      trials.set(
        token,
        Object.assign(trial, { diffRequired, preflight, expiry: now + 30 * 60_000 }),
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
    async function prepareLaunch({ sessionId, selected, draft }, signal) {
      const cwd = await ensureAgentWorkspace(ctx, ctx.get('agents')?.get(sessionId), signal);
      const frozen = launchConfig(config, selected, draft);
      const flow = catalogTemplates(frozen).find((item) => item.id === selected);
      return publishPreview(
        { sessionId, cwd, selected, config: frozen },
        resolveStartPlan(frozen, sessionId, selected),
        flow,
        signal,
      );
    }
    endpoint('prepareContinuation', async ({ sessionId, id }, signal) => {
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
        { sessionId, cwd, config, flowId: id, round: saved.round ?? 1 },
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
        const id =
          trial.flowId ?? store.listPage(cwd, { session: sessionId, limit: 1 }).items[0]?.id;
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
      if (event?.type !== 'sihq/launch') throw new Error('本会话没有该启动回执');
      return event.data;
    });
    endpoint('launchReceipt', async ({ sessionId, token }) => {
      const entry = trials.get(token);
      if (!entry?.receipt || entry.sessionId !== sessionId || Date.now() > entry.expiry)
        throw new Error('请从本会话的运行记录查看已提交的任务。');
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
    endpoint(
      'prepareTrial',
      async (payload, signal) => (await prepareLaunch(payload, signal)).token,
    );
  });
  ctx.on?.('dispose', () => {
    trials.clear();
    for (const controller of controllers) controller.abort();
  });
  ctx.inject?.(['settings'], (child) =>
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber)),
  );
  ctx.inject?.(['tools', 'agentPresets'], installReadonlyGuard);
  ctx.inject?.(['subagents', 'subprocess'], registerReadonlyCodex);
  ctx.inject?.(['subagents', 'subprocess', 'loader'], registerProductBridge);
  ctx.commands.register({
    definitionId: name,
    name: 'sihq',
    description: '选择工作流，查看分工并填写任务',
    input: { hint: '回车选择工作流，或 run "流程名" "任务"' },
    handler: (invocation) =>
      execute(ctx, config, controllers, trials, invocation, knownProviderNames),
  });
}
