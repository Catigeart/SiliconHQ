import { whileActive, withActivation } from './cancellation.js';
import { randomUUID } from 'node:crypto';
import { readonlyPreset } from './preset-options.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instancesOf, instancePrefix, resolveRoute } from './agent-instances.js';
import { reportText } from './native.js';
import { readonlyCodex } from './codex-backend.js';
import { checkedRoute } from './agent-routing.js';
export { modelChoices } from './model-route.js';

async function testActivation(ctx, spec, signal) {
  const agents = ctx.get('agents'),
    presets = ctx.get('agentPresets');
  if (!agents || !presets) throw new Error('当前 DSH profile 未启用测试会话所需的 Agent 服务');
  const cwd = await mkdtemp(join(tmpdir(), 'sihq-instance-test-'));
  try {
    const root = await agents.create({
      sessionId: randomUUID(),
      signal,
      // DSH omits closed sessions without a workspace from the chat list.
      // The activation receives its own absolute working directory below.
      meta: { agentPreset: 'sihq-readonly' },
      setup: async (scope) => {
        await presets.mount(scope, 'sihq-readonly');
      },
    });
    try {
      signal.throwIfAborted();
      const child = await ctx.get('subagents').startActivation({
        ...spec,
        parent: root.agent,
        cwd,
        signal,
        delivery: 'caller',
        label: 'SiliconHQ 实例检查',
        prompt: [
          {
            type: 'text',
            text: '这是连通性检查。请仅回复 SIHQ_OK。请勿使用工具或读写文件。',
          },
        ],
      });
      await withActivation(child, signal, async () => {
        const answer = reportText(await child.result);
        signal.throwIfAborted();
        if (answer.trim() !== 'SIHQ_OK')
          throw new Error('Agent 已响应，但没有返回指定的 SIHQ_OK。');
      });
    } finally {
      await root.dispose();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

export async function checkInstance(ctx, config, { id, live = false }, signal) {
  if (typeof id !== 'string' || typeof live !== 'boolean') throw new Error('无效的实例检查请求');
  const instances = instancesOf(config);
  const instance = instances.find((i) => i.id === id);
  if (!instance) throw new Error('实例已删除，请刷新列表');
  const service = ctx.get('subagents'),
    base = service?.getProvider(instance.backend);
  const checks = [
    {
      label: '后端注册',
      state: base ? 'pass' : 'fail',
      detail: base ? instance.backend : '未注册 ' + instance.backend,
    },
    { label: '模型路由', state: 'skipped', detail: '等待后端注册' },
    { label: '实际委派', state: 'skipped', detail: '尚未执行' },
  ];
  if (!base) return { checks };
  let spec;
  try {
    const route = resolveRoute({ backend: instancePrefix + id }, instances);
    const readOnly = route.agentPreset
      ? route.agentPreset === readonlyPreset
      : instance.backend === readonlyCodex ||
        (base.capabilities.agentPreset && !base.inheritsParentContext);
    const checked = await whileActive(
      checkedRoute(ctx, service, route, readOnly, undefined, { includeCatalog: true }),
      signal,
    );
    spec = checked.spec;
    Object.assign(checks[1], checked.modelCheck);
    if (instance.agentPreset) checks[1].detail += ' · DSH 预设 ' + instance.agentPreset;
  } catch (error) {
    Object.assign(checks[1], { state: 'fail', detail: error.message });
    return { checks };
  }
  if (live) {
    try {
      signal.throwIfAborted();
      await testActivation(ctx, spec, signal);
      Object.assign(checks[2], {
        state: 'pass',
        detail: '已收到指定回复 SIHQ_OK。',
      });
    } catch (error) {
      Object.assign(checks[2], { state: 'fail', detail: error.message });
    }
  }
  return { checks };
}
