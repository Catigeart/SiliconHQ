import z from '@deepseek-ai/schemastery';
import {
  agentName,
  backendKey,
  isAgentStep,
  describeExecutor,
  builtinSequenceSummary,
  sequenceSummary,
  defaultNodeRepairs,
  defaultRoleFields,
  defaultWorkflowId,
  defaultRepairBudget,
} from './dist/workflow/rules.js';
import {
  diffReview,
  inspectTemplates,
  selectedWorkflowTemplate,
  validateTemplates,
} from './workflow-templates.js';
import { instancesOf, resolveRoute, externalBridge, instancePrefix } from './agent-instances.js';
import { roles } from './dist/workflow/rules.js';
import { setting } from './profile-config.js';
import { providerCapabilities } from './provider-discovery.js';

const fields = {};
const node = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  instructions: z.string(),
  currentDiff: z.boolean(),
  reviewPolicy: z.string(),
  backend: z.string(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  inputs: z.array(z.string()).default([]),
  returnTo: z.string(),
  parallelGroup: z.string(),
  // Schemastery objects default to {}. Keep old unconditional steps free of a condition.
  when: z.union([z.object({ source: z.string(), equals: z.string() })]),
  verification: z.union([z.object({ argv: z.array(z.string()), timeoutMs: z.number() })]),
  maxRepairs: z.number().default(defaultNodeRepairs),
});
const templateConfig = z.object({
  id: z.string(),
  name: z.string(),
  includeDiff: z.boolean().default(false),
  steps: z.array(node),
});
const instanceConfig = z.object({
  id: z.string(),
  name: z.string(),
  backend: z.string(),
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string(),
  product: z.string(),
  agentPreset: z.string(),
});

for (const [key, value] of Object.entries(defaultRoleFields)) {
  fields[key] = (value ? z.string().min(1) : z.string()).default(value).volatile();
}
export const Config = z.object({
  ...fields,
  agentInstances: z
    .array(z.union([instanceConfig, z.any()]))
    .default([])
    .volatile(),
  reviewPolicy: z.union(['strict', 'blocking']).default('strict').volatile(),
  selectedTemplate: z.string().default(defaultWorkflowId).volatile(),
  // Keep malformed legacy rows accessible to the repair form. Every execution
  // and save is still gated by the per-template workflow schema.
  templates: z
    .array(z.union([templateConfig, z.any()]))
    .default([diffReview])
    .volatile(),
  maxRepairs: z.number().step(1).min(0).max(2).default(defaultRepairBudget).volatile(),
});

export function templateEntries(config) {
  return inspectTemplates(setting(config, 'templates', [diffReview]), {
    instanceIds: new Set(instancesOf(config).map((row) => row.id)),
  });
}

export function catalogTemplates(config, entries = templateEntries(config)) {
  const selected = setting(config, 'selectedTemplate', 'siliconhq').trim();
  const instances = instancesOf(config);
  const executor = (raw) => {
    const instance = instances.find((i) => instancePrefix + i.id === raw.backend);
    if (!instance && raw.backend.startsWith(instancePrefix)) return '已失效的 Agent 实例';
    const route = resolveRoute(raw, instances);
    return [
      instance?.name,
      agentName(instance?.backend ?? route.backend),
      [route.backend !== externalBridge && route.provider, route.model].filter(Boolean).join('/'),
      route.reasoningEffort,
      route.agentPreset && '预设 ' + route.agentPreset,
    ]
      .filter(Boolean)
      .join(' · ');
  };
  const roleSummary = (role) =>
    executor({
      backend: backendKey(setting(config, role, 'spawn')),
      provider: setting(config, role + 'Llm', ''),
      model: setting(config, role + 'Model', ''),
      reasoningEffort: setting(config, role + 'ReasoningEffort', ''),
    });
  const budget = setting(config, 'maxRepairs', defaultRepairBudget);
  const templates = [
    {
      id: 'siliconhq',
      name: 'SiliconHQ 开发流程',
      summary: builtinSequenceSummary(roleSummary, budget),
      rules: '允许开发步骤修改工作区。审查可要求修复，最多 ' + budget + ' 次。',
    },
    ...entries
      .flatMap(({ index, template }) => (template ? [{ index, template }] : []))
      .map(({ index, template: t }) => ({
        index,
        id: t.id,
        name: t.name,
        summary: sequenceSummary(
          t.steps,
          (step) => step.name + ' · ' + describeExecutor(step, executor),
        ),
        rules: [
          t.steps.some((s) => s.kind === 'verify')
            ? '验证步骤在当前工作区执行所列程序，可能修改文件。'
            : t.steps.some((s) => s.kind === 'develop')
              ? '允许开发步骤修改工作区。'
              : '全程只读。',
          t.includeDiff ? '本轮启动时冻结 Git diff，交给本轮 Agent。' : '',
          ...t.steps
            .filter((s) => s.returnTo)
            .map(
              (s) =>
                s.name +
                ' 可退回「' +
                (t.steps.find((n) => n.id === s.returnTo)?.name ?? s.returnTo) +
                '」，最多 ' +
                Math.min(budget, s.maxRepairs) +
                ' 次。',
            ),
        ].join(''),
      })),
  ];
  return templates.map((t) => ({ ...t, active: t.id === selected }));
}

export function availableProviders(service, config, knownNames, products = new Map()) {
  const configured = [
    ...instancesOf(config).map((instance) => instance.backend),
    ...[...roles, 'feedback'].map((role) => setting(config, role, 'spawn')),
    ...setting(config, 'templates', [diffReview]).flatMap((template) =>
      Array.isArray(template?.steps)
        ? template.steps.filter(isAgentStep).map((step) => step?.backend)
        : [],
    ),
  ];
  return providerCapabilities(service, configured, knownNames, products);
}

export function resolveTemplate(templates, selector) {
  const byId = templates.find((t) => t.id === selector);
  if (byId) return byId.id;
  const matches = templates.filter((t) => t.name === selector);
  if (matches.length === 1) return matches[0].id;
  if (
    !matches.length &&
    selector === 'SiliconHQ 默认流程' &&
    templates.some((t) => t.id === 'siliconhq')
  )
    return 'siliconhq';
  if (matches.length > 1) throw new Error('存在同名工作流，请从 /sihq 菜单选择或使用模板 ID。');
  throw new Error('找不到工作流「' + selector + '」。输入 /sihq 查看可选流程。');
}

// Keep the displayed template, named instances, and repair budget together until confirmation.
export function launchConfig(config, selected, draft) {
  const maxRepairs = draft ? draft.maxRepairs : setting(config, 'maxRepairs', defaultRepairBudget);
  if (!Number.isInteger(maxRepairs) || maxRepairs < 0 || maxRepairs > 2)
    throw new Error('修复次数应为 0 到 2');
  const snapshot = {
    maxRepairs,
    agentInstances: instancesOf(config),
    selectedTemplate: selected,
    templates: /** @type {import('./dist/workflow/templates.js').WorkflowTemplate[]} */ ([]),
  };
  if (selected === 'siliconhq') {
    snapshot.reviewPolicy = draft
      ? (draft.reviewPolicy ?? 'strict')
      : setting(config, 'reviewPolicy', 'strict');
    for (const role of [...roles, 'feedback']) {
      for (const suffix of ['', 'Llm', 'Model', 'ReasoningEffort']) {
        const key = role + suffix;
        const fallback = suffix ? '' : 'spawn';
        const value = draft ? (draft[key] ?? fallback) : setting(config, key, fallback);
        if (typeof value !== 'string' || (!suffix && !value.trim()))
          throw new Error('角色配置无效：' + key);
        snapshot[key] = value;
      }
    }
  } else {
    const template = draft
      ? draft.template
      : selectedWorkflowTemplate(setting(config, 'templates', [diffReview]), selected);
    if (!template || template.id !== selected)
      throw new Error('找不到要预览的工作流，请重新选择。');
    snapshot.templates = validateTemplates([template]);
  }
  return snapshot;
}
