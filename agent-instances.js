import { setting } from './profile-config.js';
import { backendKey, instanceKey, instancePrefix } from './dist/workflow/rules.js';
import { z } from 'zod';
import { externalBridge } from './product-adapter.js';
export {
  externalBridge,
  productEntries,
  productStart,
  registerProductBridge,
  selectProductSpec,
} from './product-adapter.js';

export { instancePrefix };
const text = z.string().trim().min(1);
const instanceSchema = z.strictObject({
  id: text.max(64),
  name: text.max(80),
  backend: text.max(80),
  provider: z.string().trim().optional(),
  model: z.string().trim().optional(),
  reasoningEffort: z.string().trim().optional(),
  agentPreset: text.max(256).optional(),
  product: z.enum(['codex', 'claude-code']).optional(),
});
export function instanceRows(config) {
  const rows = setting(config, 'agentInstances', []);
  if (!Array.isArray(rows)) throw new Error('Agent 实例配置必须是数组');
  return rows;
}

/** @typedef {import('zod').infer<typeof instanceSchema>} AgentInstance */
/** @typedef {{index:number, id:string, name:string, instance?:AgentInstance, diagnostic?:string}} InstanceEntry */
/** @returns {InstanceEntry[]} */
export function inspectInstances(rows) {
  if (!Array.isArray(rows)) throw new Error('Agent 实例配置必须是数组');
  const counts = new Map();
  for (const row of rows) {
    if (typeof row?.id === 'string') {
      const id = row.id.trim();
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  return rows.map((row, index) => {
    const id = typeof row?.id === 'string' ? row.id.trim() : '';
    const name = (typeof row?.name === 'string' && row.name.trim()) || '未命名实例';
    const entry = { index, id, name };
    if (id && counts.get(id) > 1) return { ...entry, diagnostic: 'Agent 实例 ID 重复：' + id };
    const parsed = instanceSchema.safeParse(row);
    if (!parsed.success)
      return {
        ...entry,
        diagnostic: parsed.error.issues
          .map((issue) => [issue.path.join('.'), issue.message].filter(Boolean).join('：'))
          .join('；'),
      };
    const instance = parsed.data;
    if (instance.backend.startsWith(instancePrefix) || instance.backend === externalBridge)
      return { ...entry, diagnostic: '基础后端不能是其他 Agent 实例或内部桥接后端' };
    return { ...entry, instance };
  });
}

export function instancesOf(config) {
  return inspectInstances(instanceRows(config)).flatMap((row) =>
    row.instance ? [row.instance] : [],
  );
}

export function validateInstanceRepair(rows, index, value) {
  if (!Array.isArray(rows) || !Number.isSafeInteger(index) || index < 0 || index >= rows.length)
    throw new Error('实例行已改变，请重新打开');
  const next = [...rows];
  next[index] = value;
  const entries = inspectInstances(next);
  const fixed = entries[index];
  if (!fixed.instance) throw new Error(fixed.diagnostic);
  if (
    rows.some(
      (row, i) => i !== index && typeof row?.name === 'string' && row.name.trim() === fixed.name,
    )
  )
    throw new Error('Agent 实例名称已被占用，请另取名称');
  return fixed.instance;
}
export function resolveRoute(route, instances) {
  const key = backendKey(route.backend);
  if (!key.startsWith(instancePrefix))
    return key === route.backend ? route : { ...route, backend: key };
  const instance = instances.find((x) => instanceKey(x.id) === key);
  if (!instance) throw new Error('找不到工作流引用的 Agent 实例：' + route.backend);
  const { backend, provider, model, reasoningEffort, ...rest } = route;
  const external = instance.product && (instance.model || instance.reasoningEffort);
  return {
    ...rest,
    instanceId: instance.id,
    instanceName: instance.name,
    baseBackend: instance.backend,
    ...(instance.product && { product: instance.product }),
    ...(instance.agentPreset && { agentPreset: instance.agentPreset }),
    backend: external ? externalBridge : instance.backend,
    ...(external
      ? { provider: instance.backend }
      : instance.provider
        ? { provider: instance.provider }
        : {}),
    ...(instance.model && { model: instance.model }),
    ...(instance.reasoningEffort && {
      reasoningEffort: instance.reasoningEffort,
    }),
  };
}

export function routeLabel(route) {
  return route.instanceName
    ? [route.instanceName, route.baseBackend, route.model, route.reasoningEffort, route.agentPreset]
        .filter(Boolean)
        .join(' · ')
    : route.backend;
}
