import assert from 'node:assert/strict';
import test from 'node:test';
import { liveChildRoute, readChildRouteEvidence } from '../child-route.js';

const header = { id: 'child', origin: 'subagent', parentSession: 'parent' };
const route = { provider: 'llm', model: 'actual', reasoningEffort: 'high' };
const descriptor = {
  type: 'subagent/descriptor',
  data: {
    version: 3,
    mode: 'continuable',
    provider: 'spawn',
    agentProvider: 'llm',
    agentModel: 'initial',
  },
};
const request = (config) => ({ type: 'request/header', data: { header: { config } } });

test('captures only the resolved options of the exact resident DSH child', () => {
  const ctx = {
    get: (key) =>
      ({
        subagents: {
          getProvider: (name) => (name === 'external' ? {} : { prepareContinuable() {} }),
        },
        agents: { get: () => ({ session: { header }, options: { ...route, maxTokens: 100 } }) },
      })[key],
  };
  assert.deepEqual(liveChildRoute(ctx, 'child', 'parent', 'spawn'), route);
  assert.equal(liveChildRoute(ctx, 'child', 'other', 'spawn'), undefined);
  assert.equal(liveChildRoute(ctx, 'child', 'parent', 'external'), undefined);
});

test('historic route uses only the original child-owned descriptor and first turn and releases every lease', async () => {
  let disposed = 0;
  const lease = {
    header,
    inheritedEventCount: 2,
    events: [descriptor, request({ model: 'parent-model' }), descriptor, request(route)],
    [Symbol.dispose]() {
      disposed++;
    },
  };
  const ctx = { get: () => ({ observeSession: async () => lease }) };
  const read = (parent = 'parent', provider = 'spawn') =>
    readChildRouteEvidence(ctx, 'child', parent, provider);
  assert.deepEqual(await read(), { route, fromRequest: true });
  assert.equal(await read('other'), undefined);
  assert.equal(await read('parent', 'other-backend'), undefined);
  lease.events.splice(3, 0, { type: 'turn/end' });
  assert.deepEqual(await read(), {
    route: { provider: 'llm', model: 'initial' },
    fromRequest: false,
  });
  lease.events.length = 2;
  assert.equal(await read(), undefined);
  assert.equal(disposed, 5);
});
