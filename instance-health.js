import { whileActive, withActivation } from './cancellation.js';
import { randomUUID } from 'node:crypto';
import { readonlyPreset } from './preset-options.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { instancesOf, instancePrefix, resolveRoute } from './agent-instances.js';
import { reportText } from './native.js';
import { readonlyCodex } from './codex-backend.js';
import { readChildTurn } from './child-route.js';
import { isCommunityRelay } from './product-adapter.js';
import { checkedRoute } from './agent-routing.js';
export { modelChoices } from './model-route.js';

function productConfirmed(_descriptor, events) {
  const calls = new Set(
    events
      .filter((event) => event.type === 'tool/call' && event.data?.name === 'product_submit')
      .map((event) => event.data.callId),
  );
  return events.some((event) => {
    const msg = event.data?.message;
    return (
      event.type === 'tool/result' &&
      msg?.isError === false &&
      calls.has(msg.toolCallId) &&
      msg.content?.some(
        (block) => block.type === 'text' && block.text.trim().split(/\r?\n/, 1)[0] === 'SIHQ_OK',
      )
    );
  });
}

async function testActivation(ctx, route, readOnly, signal) {
  const agents = ctx.get('agents'),
    presets = ctx.get('agentPresets');
  if (!agents || !presets) throw new Error('当前 DSH profile 未启用测试会话所需的 Agent 服务');
  const service = ctx.get('subagents');
  const relay = isCommunityRelay(ctx, service.getProvider(route.backend));
  const cwd = await mkdtemp(join(tmpdir(), 'sihq-instance-test-'));
  try {
    const root = await agents.create({
      sessionId: randomUUID(),
      signal,
      // The diagnostic owns its delegation tree. RC5 rejects standalone roots tagged as subagents.
      meta: { cwd, ...(!relay && { agentPreset: readonlyPreset }) },
      agentOptions: ctx.get('agentDefaultModel')?.currentSelection(),
      setup: async (scope) => {
        if (!relay) await presets.mount(scope, readonlyPreset);
      },
    });
    try {
      signal.throwIfAborted();
      const { spec } = await whileActive(
        checkedRoute(ctx, service, route, readOnly, root.agent, { cwd }),
        signal,
      );
      const probe = '这是连通性检查。请仅回复 SIHQ_OK。请勿使用工具或读写文件。';
      const child = await service.startActivation({
        ...spec,
        ...(relay && { toolFilter: { allow: ['product_submit'] } }),
        parent: root.agent,
        cwd,
        signal,
        delivery: 'caller',
        label: 'SiliconHQ 实例检查',
        prompt: [
          {
            type: 'text',
            text: relay
              ? '请通过 product_submit 将下列请求交给绑定的产品，原样返回产品的答复。\n' + probe
              : probe,
          },
        ],
      });
      await withActivation(child, signal, async () => {
        const answer = reportText(await child.result);
        signal.throwIfAborted();
        if (answer.trim() !== 'SIHQ_OK')
          throw new Error('Agent 已响应，但没有返回指定的 SIHQ_OK。');
        if (
          relay &&
          !(await readChildTurn(
            ctx,
            child.childId,
            root.agent.id,
            spec.provider,
            productConfirmed,
            AbortSignal.any([signal, AbortSignal.timeout(3000)]),
          ))
        )
          throw new Error(
            '中继已响应，但未确认产品实际回复 SIHQ_OK。请检查 Product Subagents 的 product_submit 调用记录。',
          );
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
  let route, readOnly;
  try {
    route = resolveRoute({ backend: instancePrefix + id }, instances);
    readOnly = route.agentPreset
      ? route.agentPreset === readonlyPreset
      : instance.backend === readonlyCodex ||
        (base.capabilities.agentPreset && !base.inheritsParentContext);
    const checked = await whileActive(
      checkedRoute(ctx, service, route, readOnly, undefined, { includeCatalog: true }),
      signal,
    );
    Object.assign(checks[1], checked.modelCheck);
    if (instance.agentPreset) checks[1].detail += ' · DSH 预设 ' + instance.agentPreset;
  } catch (error) {
    Object.assign(checks[1], { state: 'fail', detail: error.message });
    return { checks };
  }
  if (live) {
    try {
      signal.throwIfAborted();
      await testActivation(ctx, route, readOnly, signal);
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
