import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'node:fs';
import { checkInstance } from '../instance-health.js';

function fixture({
  answer = 'SIHQ_OK',
  models = ['sample'],
  efforts = ['high'],
  enabled = true,
} = {}) {
  const seen = { calls: [], released: 0, roots: 0 };
  const services = {
    loader: { entries: () => [] },
    llm: {
      listProviders: () => [{ id: 'test' }],
      listModels: async () => models.map((id) => ({ id })),
      resolveModelInfo: async () => ({
        reasoning: { efforts: efforts.map((id) => ({ id })) },
      }),
    },
    agentPresets: {
      resolve: async (id) => ({ id }),
      mount: async () => ({ preset: 'sihq-readonly' }),
    },
    agents: {
      async create(options) {
        seen.roots++;
        assert.deepEqual(options.meta, { agentPreset: 'sihq-readonly' });
        assert.equal(await options.setup({}), undefined);
        return {
          agent: { id: options.sessionId },
          dispose: async () => {
            seen.released++;
          },
        };
      },
    },
    subagents: {
      getProvider(name) {
        if (enabled && name === 'spawn')
          return { capabilities: { agentPreset: true, agentOptions: true } };
      },
      async startActivation(spec) {
        assert.ok(existsSync(spec.cwd));
        assert.deepEqual(readdirSync(spec.cwd), []);
        seen.calls.push(spec);
        return {
          result: Promise.resolve({
            stopReason: 'completed',
            output: [{ type: 'text', text: answer }],
          }),
          dispose: async () => {
            seen.released++;
          },
        };
      },
    },
  };
  const config = {
    agentInstances: [
      {
        id: 'a',
        name: 'A',
        backend: 'spawn',
        model: 'sample',
        reasoningEffort: 'high',
        provider: 'test',
      },
    ],
  };
  return {
    seen,
    config,
    ctx: { get: (key) => services[key] },
    check(live = false) {
      return checkInstance(this.ctx, config, { id: 'a', live }, AbortSignal.timeout(2000));
    },
  };
}

test('static check verifies the registered route and effort without creating an agent', async () => {
  const f = fixture();
  assert.deepEqual(
    (await f.check()).checks.map((c) => c.state),
    ['pass', 'pass', 'skipped'],
  );
  assert.equal(f.seen.roots, 0);
});

test('host-owned routes honor the installed LLM adapter before starting an agent', async () => {
  const f = fixture();
  const calls = [];
  f.ctx.get('llm').resolveCallConfig = async (config) => {
    calls.push(config);
    throw Error('route disabled');
  };
  const result = await f.check(true);
  assert.equal(result.checks[1].state, 'fail');
  assert.match(result.checks[1].detail, /route disabled/);
  assert.deepEqual(calls, [{ provider: 'test', model: 'sample', reasoningEffort: 'high' }]);
  assert.equal(f.seen.calls.length, 0);
});

test('failed registration or invalid effort blocks live dispatch', async () => {
  const missing = fixture({ enabled: false }),
    invalid = fixture({ efforts: ['low'] });
  assert.deepEqual(
    (await missing.check(true)).checks.map((c) => c.state),
    ['fail', 'skipped', 'skipped'],
  );
  assert.deepEqual(
    (await invalid.check(true)).checks.map((c) => c.state),
    ['pass', 'fail', 'skipped'],
  );
  assert.equal(missing.seen.roots + invalid.seen.roots, 0);
});

test('an explicitly selected preset is checked and used in the optional delegation probe', async () => {
  const f = fixture();
  f.config.agentInstances[0].agentPreset = 'builder';
  f.ctx.get('agentPresets').resolve = async (id) => ({ id });
  const result = await f.check(true);
  assert.equal(result.checks[2].state, 'pass');
  assert.match(result.checks[1].detail, /builder/);
  assert.equal(f.seen.calls[0].agentPreset, 'builder');
  f.ctx.get('agentPresets').resolve = async () => ({ broken: 'disabled' });
  assert.equal((await f.check(true)).checks[1].state, 'fail');
  assert.equal(f.seen.calls.length, 1);
});

test('live test exercises the saved route in an empty directory and disposes all resources', async () => {
  const f = fixture({ models: [] });
  assert.deepEqual(
    (await f.check(true)).checks.map((c) => c.state),
    ['pass', 'unconfirmed', 'pass'],
  );
  const [spec] = f.seen.calls;
  assert.deepEqual(spec.agentOptions, {
    provider: 'test',
    model: 'sample',
    reasoningEffort: 'high',
  });
  assert.equal(spec.agentPreset, 'sihq-readonly');
  assert.equal(f.seen.released, 2);
  assert.equal(existsSync(spec.cwd), false);
});

test('unexpected reply fails the live test while preserving successful configuration checks', async () => {
  const f = fixture({ answer: 'not the requested reply' });
  assert.deepEqual(
    (await f.check(true)).checks.map((c) => c.state),
    ['pass', 'pass', 'fail'],
  );
  assert.equal(f.seen.released, 2);
});

test('offline model discovery leaves the route available for an explicit live test', async () => {
  const f = fixture();
  f.ctx.get('llm').listModels = async () => {
    throw new Error('offline');
  };
  assert.deepEqual(
    (await f.check(true)).checks.map((c) => c.state),
    ['pass', 'unconfirmed', 'pass'],
  );
  assert.equal(f.seen.calls.length, 1);
});

test('one-shot provider route defaults feed catalog, health and the dispatched override', async () => {
  const { modelChoices } = await import('../model-route.js');
  const f = fixture();
  f.ctx.get('subagents').getProvider = () => ({
    capabilities: { agentOptions: true },
    agentRouteDefaults: { provider: 'test', model: 'sample' },
  });
  f.config.agentInstances = [
    { id: 'a', name: 'custom', backend: 'custom', reasoningEffort: 'high' },
  ];
  assert.deepEqual(
    (await modelChoices(f.ctx, { backend: 'custom' })).providers.map((p) => p.id),
    ['test'],
  );
  assert.equal((await f.check(true)).checks[2].state, 'pass');
  assert.deepEqual(f.seen.calls[0].agentOptions, {
    provider: 'test',
    model: 'sample',
    reasoningEffort: 'high',
  });
  f.config.agentInstances[0].reasoningEffort = 'unlisted';
  assert.equal((await f.check(true)).checks[1].state, 'fail');
  assert.equal(f.seen.calls.length, 1);
});

test('cancelling the model and preset check releases the live test before creating a session', async () => {
  const f = fixture(),
    entered = Promise.withResolvers(),
    gate = Promise.withResolvers(),
    controller = new AbortController();
  f.ctx.get('agentPresets').resolve = async () => {
    entered.resolve();
    await gate.promise;
    return { id: 'sihq-readonly' };
  };
  const work = checkInstance(f.ctx, f.config, { id: 'a', live: true }, controller.signal);
  await entered.promise;
  controller.abort(new Error('closed check'));
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    gate.resolve();
  }, 1000);
  try {
    const result = await work;
    assert.equal(result.checks[1].state, 'fail');
    assert.equal(late, false);
    assert.equal(f.seen.roots, 0);
  } finally {
    clearTimeout(timer);
    gate.resolve();
  }
});
