import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, Config } from '../plugin.js';
import { inspectTemplates, selectedWorkflowTemplate } from '../workflow-templates.js';

const sample = (id, fields = {}) => ({
  id,
  name: id,
  steps: [
    { id: 'read', name: '读取', kind: 'read', instructions: 'Read', backend: 'spawn', ...fields },
  ],
});

test('invalid rows are addressed by their original positions and do not prevent selecting valid siblings', () => {
  const rows = [sample('ok'), sample('x'), sample('x'), null, sample('siliconhq')];
  const inspected = inspectTemplates(rows);
  assert.deepEqual(
    inspected.filter((r) => r.diagnostic).map((r) => r.index),
    [1, 2, 3, 4],
  );
  assert.equal(selectedWorkflowTemplate(rows, 'ok').id, 'ok');
  assert.throws(() => selectedWorkflowTemplate(rows, 'x'), /重复/);
});

test('a structurally malformed legacy template does not prevent Cordis from mounting the plugin', () => {
  const malformed = { id: 'broken', name: 'Broken', steps: 'legacy format' };
  const mounted = Config({ templates: [malformed, sample('working')] }).templates.get();
  assert.deepEqual(mounted[0], malformed);
  assert.equal(inspectTemplates(mounted)[1].template.id, 'working');
});

test('catalog and save validation share diagnostics, with providers available during template repair', async () => {
  const config = {
    templates: [
      sample('ok'),
      sample('broken', { inputs: ['deleted'] }),
      sample('missing', { backend: 'sihq-agent:gone' }),
    ],
  };
  const routes = new Map();
  const ctx = {
    commands: { register() {} },
    inject(names, fn) {
      if (names.includes('connection'))
        fn({
          connection: {
            fetch: {
              register(r) {
                routes.set(r.path, r);
              },
            },
          },
        });
    },
    get(name) {
      if (name === 'agentPresets') return { resolve: async (id) => ({ id }) };
      if (name === 'subagents')
        return {
          getProvider(key) {
            return key === 'spawn' && { capabilities: { agentPreset: true, agentOptions: true } };
          },
        };
    },
  };
  apply(ctx, config);
  async function call(method, payload = {}) {
    const path = '/api/sihqCatalog/' + method;
    const response = await routes.get(path).fetch(
      new Request('http://localhost' + path, {
        method: 'POST',
        body: JSON.stringify({ rpcId: 'fixture', payload }),
      }),
    );
    return (await response.json()).result;
  }
  const result = await call('catalog');
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.value.templates.map((t) => t.id),
    ['siliconhq', 'ok'],
  );
  assert.deepEqual(
    result.value.diagnostics.map((t) => t.id),
    ['broken', 'missing'],
  );
  assert.ok(result.value.providers.some((p) => p.name === 'spawn'));
  assert.match(result.value.diagnostics[0].diagnostic, /第 1 步.*输入/);
  assert.equal(result.value.diagnostics[1].editable, true);
  assert.equal((await call('validateTemplate', { template: config.templates[1] })).ok, false);
  const fixed = await call('validateTemplate', { template: sample('broken') });
  assert.equal(fixed.ok, true);
  assert.deepEqual(fixed.value.steps[0].inputs, []);
});
