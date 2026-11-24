import { test } from 'node:test';
import assert from 'node:assert/strict';
import { observeProviderNames, providerCapabilities } from '../provider-discovery.js';
import { createModelChoices } from '../client/model-catalog.js';

test('RC5 backend discovery tracks pre-existing and later providers and flags missing configuration', () => {
  const events = new Map();
  const names = observeProviderNames({ on: (key, fn) => events.set(key, fn) });
  const writable = { capabilities: { agentPreset: true, agentOptions: true } };
  const providers = new Map([
    ['local-acp', writable],
    ['fork', { ...writable, inheritsParentContext: true }],
  ]);
  const service = { providers, getProvider: (name) => providers.get(name) };
  const list = () => providerCapabilities(service, ['missing-backend'], names(service));
  assert.ok(list().find((p) => p.name === 'local-acp').agentPreset);
  assert.equal(list().find((p) => p.name === 'missing-backend').registered, false);
  assert.equal(list().find((p) => p.name === 'fork').agentPreset, false);
  // A host may expose only getProvider. Lifecycle events still discover custom names.
  delete service.providers;
  providers.set('new-acp', writable);
  events.get('subagent/provider-added')({ name: 'new-acp' });
  assert.ok(list().some((p) => p.name === 'new-acp' && p.registered));
  providers.delete('new-acp');
  events.get('subagent/provider-removed')('new-acp');
  assert.ok(!list().some((p) => p.name === 'new-acp'));
  assert.ok(providerCapabilities(service, []).some((p) => p.name === 'fork'));
});

test('model choices share the RC5 session catalog, refresh on host changes, and keep CLI models independent', async () => {
  const events = new Map(),
    requests = [];
  let count = 0,
    name = 'one';
  const ctx = {
    effect: (fn) => fn(),
    on: (key, fn) => events.set(key, fn),
    remote: {
      $on: (key, fn) => events.set(key, fn),
      session: {
        async modelCatalog() {
          count++;
          return {
            ok: true,
            value: {
              groups: [{ id: 'local', name: 'Local', models: [{ id: name }] }],
              failures: ['unavailable'],
            },
          };
        },
      },
    },
  };
  const load = createModelChoices(ctx, async (_method, payload) => {
    requests.push(payload.backend);
    return { efforts: ['from-host-or-product'] };
  });
  const [a, b] = await Promise.all([
    load({ backend: 'fork' }),
    load({ backend: 'spawn', provider: 'local' }),
  ]);
  assert.equal(count, 1);
  assert.deepEqual(a.providers, [{ id: 'local', name: 'Local' }]);
  assert.equal(a.partial, true);
  assert.deepEqual(b.models, [{ id: 'one', name: 'one' }]);
  let updates = 0;
  const off = load.subscribe(() => updates++);
  for (const key of ['llm/adapters-updated', 'settings/document-updated', 'connection/reset'])
    events.get(key)();
  off();
  assert.equal(updates, 3);
  name = 'two';
  assert.equal((await load({ backend: 'spawn', provider: 'local' })).models[0].id, 'two');
  await load({ backend: 'claude-code' });
  await load({ backend: 'spawn', provider: 'local', model: 'two' });
  assert.deepEqual(requests, ['claude-code', 'spawn']);
  assert.equal(count, 2);
});
