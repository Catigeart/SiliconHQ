import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../plugin.js';

function fixture(t, services = {}) {
  const cwd = mkdtempSync(join(tmpdir(), 'sihq-preflight-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const agent = { id: 'test', session: { header: { cwd } } };
  const step = (id, kind, backend) => ({ id, name: id, kind, backend, instructions: id });
  const config = {
    templates: [
      {
        id: 'test-flow',
        name: 'Test Flow',
        includeDiff: true,
        steps: [
          step('开发', 'develop', 'missing'),
          step('核查', 'review', 'fork'),
          step('批准', 'approval', 'human'),
        ],
      },
    ],
    feedback: 'missing-feedback',
  };
  const routes = new Map();
  const providers = new Map([
    ['spawn', { capabilities: { agentPreset: true } }],
    ['fork', { inheritsParentContext: true, capabilities: { agentPreset: true } }],
  ]);
  let command,
    jobs = 0,
    activations = 0;
  apply(
    {
      commands: {
        register(value) {
          command = value;
        },
      },
      inject(names, cb) {
        if (names.includes('connection'))
          cb({
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
        if (services[name]) return services[name];
        if (name === 'agentPresets') return { resolve: async (id) => ({ id }) };
        if (name === 'agents')
          return {
            get() {
              return agent;
            },
          };
        if (name === 'jobs')
          return {
            start() {
              jobs++;
              return 'job';
            },
          };
        if (name === 'subagents')
          return {
            getProvider: (id) => providers.get(id),
            startActivation() {
              activations++;
            },
          };
      },
    },
    config,
  );
  async function preview(selected, draft) {
    const path = '/api/sihqCatalog/prepareLaunch';
    const result = await routes.get(path).fetch(
      new Request('http://localhost' + path, {
        method: 'POST',
        body: JSON.stringify({ rpcId: 'id', payload: { sessionId: agent.id, selected, draft } }),
      }),
    );
    return (await result.json()).result;
  }
  const run = (rawInput, signal = new AbortController().signal) =>
    command.handler({ agent, rawInput, signal });
  return { previews: preview, run, config, providers, counts: () => [jobs, activations] };
}

test('preflight aggregates faults by step and blocks commands before creating a job', async (t) => {
  const f = fixture(t);
  const preview = await f.previews('test-flow');
  assert.equal(preview.ok, true);
  const report = preview.value.flow.preflight;
  assert.equal(report.ok, false);
  assert.deepEqual(
    report.diagnostics.map((item) => item.step),
    ['Git diff', '开发', '核查'],
  );
  for (const command of [
    'run "Test Flow" "任务"',
    'workflow --template test-flow "任务"',
    JSON.stringify(['launch', preview.value.token, '任务']),
  ]) {
    const result = await f.run(command);
    assert.equal(result.kind, 'error');
    assert.match(result.text, /Git diff/);
    assert.match(result.text, /开发.*missing/);
    assert.match(result.text, /核查.*fork/);
  }
  assert.deepEqual(f.counts(), [0, 0]);
});

test('draft preflight validates the feedback route and previews conditional closeout', async (t) => {
  const f = fixture(t);
  const result = await f.previews('siliconhq', { maxRepairs: 1, feedback: 'missing-feedback' });
  assert.equal(result.ok, true);
  assert.match(result.value.flow.summary, /开发反馈.*missing-feedback.*最终汇总/);
  assert.deepEqual(
    result.value.flow.preflight.diagnostics.map((row) => row.step),
    ['开发反馈'],
  );
  assert.deepEqual(f.counts(), [0, 0]);
});

test('a prepared token rechecks registration before submission; a failed check may be retried', async (t) => {
  const f = fixture(t);
  const flow = f.config.templates[0];
  flow.includeDiff = false;
  for (const s of flow.steps) if (s.kind !== 'approval') s.backend = 'spawn';
  const preview = await f.previews(flow.id);
  assert.equal(preview.value.flow.preflight.ok, true);
  const token = preview.value.token;
  const provider = f.providers.get('spawn');
  f.providers.delete('spawn');
  const result = await f.run(JSON.stringify(['launch', token, 'task']));
  assert.equal(result.kind, 'error');
  assert.deepEqual(f.counts(), [0, 0]);
  f.providers.set('spawn', provider);
  assert.equal((await f.run(JSON.stringify(['launch', token, 'task']))).kind, 'success');
  assert.deepEqual(f.counts(), [1, 0]);
});

test('explicit template invocation treats reserved command and option words as task text', async (t) => {
  const f = fixture(t);
  f.config.templates[0].includeDiff = false;
  for (const s of f.config.templates[0].steps) if (s.kind !== 'approval') s.backend = 'spawn';
  for (const task of ['resume', 'list', '--fast', '--']) {
    const result = await f.run(JSON.stringify(['workflow', '--template', 'test-flow', task]));
    assert.equal(result.kind, 'success', result.text);
  }
  assert.equal(f.counts()[0], 4);
});

test('cancelling during preflight answers before the resolver and creates no Job', async (t) => {
  const entered = Promise.withResolvers(),
    release = Promise.withResolvers();
  const f = fixture(t, {
    agentPresets: {
      resolve() {
        entered.resolve();
        return release.promise;
      },
    },
  });
  f.config.templates = [
    {
      id: 'w',
      name: 'w',
      steps: [{ id: 'r', name: 'r', kind: 'read', backend: 'spawn', instructions: 'read' }],
    },
  ];
  const controller = new AbortController();
  const command = f.run('workflow --template w task', controller.signal);
  await entered.promise;
  controller.abort(new Error('cancelled during preflight'));
  try {
    assert.equal(
      await Promise.race([
        command.then((v) => v.kind),
        new Promise((r) => setImmediate(() => r('pending'))),
      ]),
      'error',
    );
  } finally {
    release.resolve({ id: 'sihq-readonly' });
    await command;
  }
  assert.deepEqual(f.counts(), [0, 0]);
});
