import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  externalBridge,
  inspectInstances,
  instancePrefix,
  instanceRows,
  instancesOf,
} from './agent-instances.js';
import {
  diffReview,
  workflowTemplateSchema,
  selectedWorkflowTemplate,
} from './workflow-templates.js';
import { roles } from './dist/workflow/rules.js';
import { setting } from './profile-config.js';
import { supportsRoute } from './route-compatibility.js';
import { isAgentStep, verificationSteps } from './dist/workflow/rules.js';

const roleNames = [...roles, 'feedback'];
const routeKeys = {
  backend: '',
  provider: 'Llm',
  model: 'Model',
  reasoningEffort: 'ReasoningEffort',
};
const routeSchema = z.strictObject({
  backend: z.string().trim().min(1),
  provider: z.string().trim().optional(),
  model: z.string().trim().optional(),
  reasoningEffort: z.string().trim().optional(),
});
const builtinRoles = z.strictObject(
  Object.fromEntries(roleNames.map((role) => [role, routeSchema])),
);
const fileSchema = z.strictObject({
  format: z.literal('dsh-sihq/workflow'),
  version: z.literal(1),
  workflow: z.discriminatedUnion('kind', [
    z.strictObject({
      kind: z.literal('custom'),
      template: workflowTemplateSchema,
    }),
    z.strictObject({
      kind: z.literal('builtin'),
      roles: builtinRoles,
      reviewPolicy: z.enum(['strict', 'blocking']).optional(),
    }),
  ]),
  instances: z.array(z.unknown()),
  profileRepairLimit: z.number().int().min(0).max(2),
});

function routesOf(workflow) {
  if (workflow.kind === 'builtin')
    return roleNames.map((role) => ({
      route: workflow.roles[role],
      read: role !== 'developer',
    }));
  return workflow.template.steps
    .filter(isAgentStep)
    .map((s) => ({ route: s, read: s.kind !== 'develop' }));
}

function workflowTemplates(config) {
  return setting(config, 'templates', [diffReview]);
}
function readBuiltinRole(config, role) {
  return routeSchema.parse(
    Object.fromEntries(
      Object.entries(routeKeys).map(([field, suffix]) => [
        field,
        setting(config, role + suffix, field === 'backend' ? 'spawn' : ''),
      ]),
    ),
  );
}

export function exportWorkflow(config, id) {
  let workflow;
  if (id === 'siliconhq') {
    workflow = {
      kind: 'builtin',
      ...(setting(config, 'reviewPolicy', 'strict') === 'blocking' && { reviewPolicy: 'blocking' }),
      roles: Object.fromEntries(roleNames.map((role) => [role, readBuiltinRole(config, role)])),
    };
  } else {
    const template = selectedWorkflowTemplate(workflowTemplates(config), id);
    if (!template) throw new Error('工作流已删除，请刷新列表');
    workflow = { kind: 'custom', template };
  }
  const refs = new Set(routesOf(workflow).map(({ route }) => route.backend));
  const instances = instancesOf(config).filter((i) => refs.has(instancePrefix + i.id));
  const file = {
    format: 'dsh-sihq/workflow',
    version: 1,
    workflow,
    instances,
    profileRepairLimit: setting(config, 'maxRepairs', 2),
  };
  readFile(file);
  return file;
}

function readFile(value) {
  if (value?.format !== 'dsh-sihq/workflow' || value.version !== 1)
    throw new Error('请选择受支持的 SiliconHQ 工作流 JSON 文件（版本 1）');
  const file = fileSchema.parse(value);
  // The local profile can keep a damaged row for repair. An imported file must be complete.
  const instances = inspectInstances(file.instances).map((row) => {
    if (!row.instance)
      throw new Error('文件中的 Agent 实例第 ' + (row.index + 1) + ' 行：' + row.diagnostic);
    return row.instance;
  });
  const byRef = new Map(instances.map((i) => [instancePrefix + i.id, i]));
  const referenced = new Set(),
    requirements = new Map();
  for (const { route, read } of routesOf(file.workflow)) {
    const named = route.backend.startsWith(instancePrefix);
    const effective = named ? byRef.get(route.backend) : route;
    if (!effective) throw new Error('文件缺少引用的 Agent 实例：' + route.backend);
    if (effective.backend === externalBridge) throw new Error('不能导入内部桥接后端');
    if (named) referenced.add(effective.id);
    const reqs = requirements.get(effective.backend) ?? [];
    reqs.push({ effective, named, read });
    requirements.set(effective.backend, reqs);
  }
  if (referenced.size !== instances.length) throw new Error('文件包含未被工作流引用的 Agent 实例');
  return { ...file, instances, requirements };
}

function compatible(p, { effective: r, named, read }, clear = false) {
  return supportsRoute(p, clear ? {} : r, read, named);
}
function availableTargets(requirements, providers) {
  return [...requirements].map(([source, reqs]) => ({
    source,
    sourceProducts: [...new Set(reqs.map(({ effective }) => effective.product).filter(Boolean))],
    targetProducts: Object.fromEntries(
      providers.filter((p) => p.product).map((p) => [p.name, p.product]),
    ),
    targets: providers.filter((p) => reqs.every((r) => compatible(p, r))).map((p) => p.name),
    clearTargets: providers
      .filter((p) => reqs.every((r) => compatible(p, r, true)))
      .map((p) => p.name),
    hasOverrides: reqs.some(
      ({ effective: r }) =>
        r.product || r.provider || r.model || r.reasoningEffort || r.agentPreset,
    ),
  }));
}

// Rebuild the allowed bindings against the current target profile at preview and commit.
// An explicitly selected local instance supplies its own backend and all its overrides.
function instanceBindings(file, providers, existing, choices) {
  const entries = z.array(z.tuple([z.string(), z.string()])).parse(choices);
  const modes = new Map(entries);
  if (
    modes.size !== entries.length ||
    [...modes.keys()].some((id) => !file.instances.some((i) => i.id === id))
  )
    throw new Error('实例映射包含重复或未知的源实例');
  const bound = new Map();
  const rows = file.instances.map((source) => {
    const uses = file.requirements
      .get(source.backend)
      .filter((r) => r.named && r.effective.id === source.id);
    const matches = existing.filter((target) => {
      const provider = providers.find((p) => p.name === target.backend);
      return uses.every((r) => compatible(provider, { ...r, effective: target }));
    });
    const mode = modes.get(source.id);
    if (mode !== undefined && mode !== 'new') {
      const target = matches.find((i) => mode === instancePrefix + i.id);
      if (!target) throw new Error('该目标实例已不存在或与步骤权限不兼容：' + source.name);
      bound.set(source.id, target);
    }
    return {
      id: source.id,
      name: source.name,
      targets: matches.map((i) => ({ id: i.id, label: instanceLabel(i) })),
    };
  });
  const requirements = new Map();
  for (const [backend, uses] of file.requirements) {
    const unmapped = uses.filter((r) => !r.named || !bound.has(r.effective.id));
    if (unmapped.length) requirements.set(backend, unmapped);
  }
  return { rows, modes, bound, requirements };
}
function instanceLabel(route) {
  return [
    route.name,
    route.backend,
    route.provider,
    route.model || '默认模型',
    route.reasoningEffort || '默认强度',
    route.agentPreset,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function inspectImport(value, providers, config = {}, instanceChoices = []) {
  const file = readFile(value);
  const { workflow, instances, profileRepairLimit } = file;
  const { rows, requirements } = instanceBindings(
    file,
    providers,
    instancesOf(config),
    instanceChoices,
  );
  return {
    kind: workflow.kind,
    name: workflow.kind === 'builtin' ? 'SiliconHQ 开发流程' : workflow.template.name,
    steps:
      workflow.kind === 'builtin'
        ? ['计划', '开发与修复', '审查', '反馈']
        : workflow.template.steps.map((s) => s.name),
    verificationSteps:
      workflow.kind === 'builtin' ? [] : verificationSteps(workflow.template.steps),
    instances: instances.map((i) => i.name),
    instanceMappings: rows,
    backends: availableTargets(requirements, providers),
    profileRepairLimit,
  };
}

function availableName(title, rows) {
  const names = new Set(rows.map((i) => i?.name));
  if (!names.has(title)) return title;
  for (let i = 1; ; i++) {
    const suffix = i === 1 ? '（导入）' : '（导入 ' + i + '）';
    const name = title.slice(0, 80 - suffix.length) + suffix;
    if (!names.has(name)) return name;
  }
}
function sameSettings(a, b) {
  return ['backend', 'model', 'provider', 'reasoningEffort', 'agentPreset', 'product'].every(
    (k) => (a[k] || '') === (b[k] || ''),
  );
}
function automaticInstance(rows, candidate) {
  const same = rows.filter((i) => sameSettings(i, candidate));
  const exact =
    same.find((i) => i.id === candidate.id) ?? same.find((i) => i.name === candidate.name);
  if (exact) return exact;
  // Version 1 imports allocated random IDs. Recognize their collision suffix even
  // when the original name had to be truncated to fit the profile's name limit.
  return same.find((i) => {
    const suffix = i.name.match(/（导入(?: [1-9]\d*)?）$/u)?.[0];
    return suffix && i.name === candidate.name.slice(0, 80 - suffix.length) + suffix;
  });
}

// The caller submits these operations together using the config-form revision read for the preview.
export function prepareImport(
  config,
  value,
  choices,
  providers,
  syncBudget = false,
  clearOverrides = [],
  instanceChoices = [],
) {
  const file = readFile(value);
  const { workflow, instances, profileRepairLimit } = file;
  const existing = instancesOf(config);
  const { bound, modes, requirements } = instanceBindings(
    file,
    providers,
    existing,
    instanceChoices,
  );
  const mapping = new Map(z.array(z.tuple([z.string(), z.string()])).parse(choices));
  if (mapping.size !== requirements.size || choices.length !== mapping.size)
    throw new Error('请为每个源后端选择一个目标');
  const clear = new Set(z.array(z.string()).parse(clearOverrides));
  const withoutOverrides = (r) => {
    const { provider, model, reasoningEffort, agentPreset, ...rest } = r;
    return clear.has(r.backend) ? rest : r;
  };
  for (const { source, targets, clearTargets } of availableTargets(requirements, providers))
    if (!(clear.has(source) ? clearTargets : targets).includes(mapping.get(source)))
      throw new Error('请选择可用且与步骤权限兼容的目标后端：' + source);
  const next = [...existing],
    stored = [...instanceRows(config)],
    rewritten = new Map(mapping),
    created = [],
    reused = [];
  for (const instance of instances) {
    if (bound.has(instance.id)) {
      const target = bound.get(instance.id);
      reused.push(target.name);
      rewritten.set(instancePrefix + instance.id, instancePrefix + target.id);
      continue;
    }
    const backend = mapping.get(instance.backend);
    const { product: _sourceProduct, ...fields } = withoutOverrides(instance);
    const product = providers.find((p) => p.name === backend)?.product;
    const candidate = { ...fields, backend, ...(product && { product }) };
    let target = modes.get(instance.id) === 'new' ? undefined : automaticInstance(next, candidate);
    if (target) reused.push(target.name);
    else {
      target = {
        ...candidate,
        id: randomUUID(),
        name: availableName(candidate.name, stored),
      };
      next.push(target);
      stored.push(target);
      created.push(target.name);
    }
    rewritten.set(instancePrefix + instance.id, instancePrefix + target.id);
  }
  const ops = [];
  const set = (key, value) => ops.push({ op: 'set', path: [key], value });
  if (created.length) set('agentInstances', stored);
  const changes = [];
  function label(route, all) {
    const item = all.find((i) => instancePrefix + i.id === route.backend);
    const r = item ?? route;
    return [
      item?.name,
      r.backend,
      r.provider,
      r.model || '默认模型',
      r.reasoningEffort || '默认强度',
      r.agentPreset,
    ]
      .filter(Boolean)
      .join(' · ');
  }
  let name;
  if (workflow.kind === 'custom') {
    const templates = workflowTemplates(config);
    name = availableName(workflow.template.name, [...templates, { name: 'SiliconHQ 开发流程' }]);
    const steps = workflow.template.steps.map((s) =>
      isAgentStep(s) ? { ...withoutOverrides(s), backend: rewritten.get(s.backend) } : s,
    );
    const template = workflowTemplateSchema.parse({
      ...workflow.template,
      id: randomUUID(),
      name,
      steps,
    });
    set('templates', [...templates, template]);
  } else {
    name = 'SiliconHQ 开发流程';
    const policy = workflow.reviewPolicy ?? 'strict';
    const beforePolicy = setting(config, 'reviewPolicy', 'strict');
    if (policy !== beforePolicy) {
      const label = (p) => (p === 'blocking' ? '按阻塞级别验收' : '严格验收');
      changes.push({ role: 'reviewPolicy', before: label(beforePolicy), after: label(policy) });
      set('reviewPolicy', policy);
    }
    for (const role of roleNames) {
      const route = withoutOverrides(workflow.roles[role]);
      const before = readBuiltinRole(config, role);
      const after = { ...route, backend: rewritten.get(route.backend) };
      changes.push({
        role,
        before: label(before, existing),
        after: label(after, next),
      });
      for (const [field, suffix] of Object.entries(routeKeys))
        set(role + suffix, field === 'backend' ? rewritten.get(route.backend) : route[field] || '');
    }
  }
  if (syncBudget === true) set('maxRepairs', profileRepairLimit);
  return { ops, name, created, reused, changes };
}
