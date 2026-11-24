import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedRoute, routeFor } from '../agent-routing.js';
import { instancesOf, resolveRoute } from '../agent-instances.js';
import { preflightWorkflow } from '../workflow-preflight.js';
import { productEntries } from '../product-adapter.js';
import { providerCapabilities } from '../provider-discovery.js';

function fixture() {
  const config = { providerName: 'worker', permissionMode: 'acceptEdits' };
  const record = {
    options: { name: '@deepseek-ai/dsh-subagent-claude-code', config },
    fiber: { state: 2, resolveConfig: (x) => x },
    moduleNamespace: { apply() {} },
  };
  const registry = new Map([
    ['worker', { capabilities: {}, inheritsParentContext: false }],
    ['spawn', { capabilities: { agentOptions: true, agentPreset: true } }],
    ['sihq-product-instance', { capabilities: { agentOptions: true } }],
  ]);
  const services = {
    subagents: { getProvider: (name) => registry.get(name) },
    jobs: {},
    loader: { entries: () => [record] },
    llm: { listProviders: () => [{ id: 'local' }] },
    agentPresets: { resolve: async (id) => ({ id }) },
  };
  return { config, record, services, ctx: { get: (key) => services[key] } };
}

test('inherited and overridden named product routes reject an alias rebound to another product', async () => {
  const { record, ctx, services } = fixture();
  for (const model of [undefined, 'opus']) {
    const route = resolveRoute(
      { backend: 'sihq-agent:a' },
      instancesOf({
        agentInstances: [{ id: 'a', name: 'A', backend: 'worker', product: 'claude-code', model }],
      }),
    );
    record.options.name = '@deepseek-ai/dsh-subagent-claude-code';
    const expected = model ? 'sihq-product-instance' : 'worker';
    assert.equal(
      (await checkedRoute(ctx, services.subagents, route, false)).spec.provider,
      expected,
    );
    record.options.name = '@deepseek-ai/dsh-subagent-codex';
    assert.throws(() => routeFor(services.subagents, route, false, ctx), /产品后端绑定已变化/);
    const report = await preflightWorkflow(
      ctx,
      { template: { steps: [{ ...route, kind: 'develop', name: 'write' }] } },
      process.cwd(),
    );
    assert.equal(report.ok, false);
    assert.match(report.diagnostics[0].message, /产品后端绑定已变化/);
  }
});

test('Claude plan, a missing effective reader preset and a mistyped LLM all fail before admission', async () => {
  const { config, ctx, services } = fixture();
  config.permissionMode = 'plan';
  services.agentPresets.resolve = async (id) => {
    throw Error('missing ' + id);
  };
  const item = providerCapabilities(services.subagents, ['worker'], [], productEntries(ctx)).find(
    (p) => p.name === 'worker',
  );
  assert.equal(item.develop, false);
  assert.match(item.restriction, /plan/);
  const steps = [
    { kind: 'develop', name: 'write', backend: 'worker' },
    { kind: 'read', name: 'inspect', backend: 'spawn' },
    { kind: 'develop', name: 'model', backend: 'spawn', provider: 'not-registered' },
  ];
  const result = await preflightWorkflow(ctx, { template: { steps } }, process.cwd());
  assert.equal(result.ok, false);
  for (const [i, pattern] of [/plan/, /missing sihq-readonly/, /未注册模型供应商/].entries())
    assert.match(result.diagnostics[i].message, pattern);
});

test('external backends may own providers and models absent from the DSH LLM catalog', async () => {
  const { ctx, services } = fixture();
  services.subagents.getProvider = () => ({ capabilities: { agentOptions: true } });
  const route = { backend: 'third-party', provider: 'local-to-backend', model: 'own-model' };
  const checked = await checkedRoute(ctx, services.subagents, route, false);
  assert.deepEqual(checked.spec.agentOptions, { provider: 'local-to-backend', model: 'own-model' });
  assert.equal(checked.modelCheck.state, 'unconfirmed');
});

test('one-shot third-party options use the backend namespace consistently', async () => {
  const { modelChoices, inspectModel } = await import('../model-route.js');
  const ctx = {
    get: (key) =>
      key === 'subagents'
        ? { getProvider: () => ({ capabilities: { agentOptions: true } }) }
        : undefined,
  };
  assert.deepEqual(await modelChoices(ctx, { backend: 'external' }), { manual: true });
  assert.equal(
    (await inspectModel(ctx, { backend: 'external', model: 'own' })).state,
    'unconfirmed',
  );
});
