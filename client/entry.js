import {
  agentName,
  builtinSequenceSummary,
  describeExecutor,
  sequenceSummary,
} from '../dist/workflow/rules.js';
import { createModelChoices } from './model-catalog.js';
import { installRunHistory } from './run-history.js';
import { Settings } from './settings.js';
import { h } from './ui.js';
import { exampleCommand, instanceKey, instanceSummary } from './workflow-model.js';

function apply(ctx) {
  const { historyOption, savedOptionPrefix, history, openLaunchDialog } = installRunHistory(
    ctx,
    call,
  );

  const editor = { edit: null, selection: null };
  let trial;
  const clearTrial = () => {
    trial = undefined;
  };
  const draftOption = '$sihq-draft';
  async function call(method, payload, signal = undefined) {
    const response = await ctx.connection.rpc.call(
      '/api',
      'sihqCatalog/' + method,
      payload,
      signal,
    );
    if (!response.ok) throw new Error(response.error.message);
    return response.value;
  }
  const instanceCheck = (payload, signal) => call('instanceCheck', payload, signal);
  const previewStep = (payload) => call('previewStep', payload);
  const modelChoices = createModelChoices(ctx, call);
  const catalog = (inspectInstanceRows = undefined) => call('workflows', { inspectInstanceRows });
  const loadProviders = () => call('providers', {});
  function stageTrial(id, draft, instances) {
    const display = (backend, provider, model, effort) => {
      const instance = instances.find((i) => instanceKey(i.id) === backend);
      if (instance) return instance.name + ' · ' + instanceSummary(instance);
      return [agentName(backend), [provider, model].filter(Boolean).join('/'), effort]
        .filter(Boolean)
        .join(' · ');
    };
    const t = draft.template;
    const summary = t
      ? sequenceSummary(
          t.steps,
          (s) =>
            s.name +
            ' · ' +
            describeExecutor(s, (step) =>
              display(step.backend, step.provider, step.model, step.reasoningEffort),
            ),
        )
      : builtinSequenceSummary(
          (role) =>
            display(
              draft[role],
              draft[role + 'Llm'],
              draft[role + 'Model'],
              draft[role + 'ReasoningEffort'],
            ),
          draft.maxRepairs,
        );
    trial = { id, draft, name: t?.name || 'SiliconHQ 开发流程', summary };
  }
  ctx.commandUi.decorate({
    name: 'sihq',
    available: () => true,
    ui: {
      kind: 'popupSelect',
      searchLabels: () => ({
        placeholder: '选择工作流',
        empty: '尚无工作流',
        noResults: '未找到匹配的流程',
      }),
      async options() {
        const result = await catalog().catch((e) => ({ templates: [], error: e.message }));
        const { templates } = result;
        const options = templates.map((t) => ({
          id: savedOptionPrefix + t.id,
          label: t.name,
          detail: t.summary,
          active: t.active,
          ...(t.active && { badge: '默认' }),
        }));
        if (trial)
          options.unshift({
            id: draftOption,
            label: trial.name,
            badge: '草稿',
            detail: trial.summary,
          });
        options.push({
          id: historyOption,
          label: '本会话运行记录',
          detail: result.error
            ? '流程清单暂时不可用：' + result.error
            : '查看已运行流程的步骤和报告',
        });
        return options;
      },
      async onSelect(option, { sessionId }) {
        if (option.id === historyOption) {
          history(sessionId);
          return;
        }
        const draft = option.id === draftOption ? trial : null;
        if (option.id === draftOption && !draft) throw new Error('草稿已失效，请重新试用。');
        const plan = await call('prepareLaunch', {
          sessionId,
          selected: draft?.id ?? option.id.slice(savedOptionPrefix.length),
          ...(draft && { draft: draft.draft }),
        });
        if (!draft) plan.command = exampleCommand(plan.flow);
        openLaunchDialog(sessionId, plan, false);
      },
    },
  });
  ctx.effect(() =>
    ctx.configForms.whileServed(['siliconhq-command'], () =>
      ctx.slots.inject('plugins.bundle.config', () =>
        ctx.slots.register(
          {
            name: 'plugins.bundle.config',
            key: 'dsh-sihq',
          },
          () =>
            h(Settings, {
              rpc: call,
              scope: ctx.configForms.get('siliconhq-command'),
              catalog,
              loadProviders,
              instanceCheck,
              modelChoices,
              previewStep,
              stageTrial,
              editor,
              clearTrial,
            }),
        ),
      ),
    ),
  );
}

export default {
  inject: [
    'configForms',
    'slots',
    'commandUi',
    'sessions',
    'connection',
    'remote',
    'remote.commands',
    'remote.session',
  ],
  apply,
};
