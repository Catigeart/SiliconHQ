import {
  templateEntries,
  catalogTemplates,
  availableProviders,
  launchConfig,
} from './workflow-catalog.js';
import { exportWorkflow, inspectImport, prepareImport } from './workflow-portable.js';
import { sessionWorkspace } from './dsh-workspace.js';
import { checkInstance, modelChoices } from './instance-health.js';
import { listPresetOptions, readonlyPreset } from './preset-options.js';
import {
  resolveRoute,
  inspectInstances,
  instanceRows,
  instancesOf,
  validateInstanceRepair,
  productEntries,
} from './agent-instances.js';
import { previewStepInput } from './step-prompt.js';
import { inspectTemplates } from './workflow-templates.js';
import { routeFor, activationPrompt, hostSchema, routing } from './native.js';

export function registerCatalog(ctx, config, endpoint, knownProviderNames, controllers) {
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
  endpoint('catalog', async ({ sessionId = undefined, inspectInstanceRows = undefined } = {}) => ({
    ...workflows({ inspectInstanceRows: inspectInstanceRows ?? instanceRows(config) }),
    providers: await portableProviders(),
    cwd: sessionId ? sessionWorkspace(ctx, sessionId) : undefined,
  }));
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
}
