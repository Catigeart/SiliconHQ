// DSH exposes preset display metadata separately from its retained compositions.
// Return module names only: neither loader details nor plugin configuration belong in settings.
export { readonlyPreset } from './route-compatibility.js';

export async function listPresetOptions(ctx) {
  const registry = ctx.get('agentPresets');
  if (!registry?.list) return [];
  const rows = await registry.list();
  const compositions = registry.inspectCompositions?.() ?? [];
  return rows.map(({ id, name, description, broken }) => {
    const revisions = compositions.filter((item) => item.id === id);
    // Several retained generations can have different tools. Only show
    // installed modules when the generation is unambiguous.
    const plugins =
      revisions.length === 1
        ? [...new Set(revisions[0].modules.map((item) => item.moduleName))]
        : [];
    return { id, name, description, broken, plugins };
  });
}

export async function validatePreset(ctx, id) {
  if (!id) return;
  const registry = ctx.get('agentPresets');
  if (!registry?.resolve) throw new Error('当前 DSH profile 未启用 Agent 预设服务');
  const resolved = await registry.resolve(id);
  if (resolved.broken) throw new Error('Agent 预设「' + id + '」不可用：' + resolved.broken);
}
