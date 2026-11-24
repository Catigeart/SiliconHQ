import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../plugin.js';
import { canonicalProjectDirectory } from '../dist/storage/project-path.js';

test('preview, history, and every admission use the frozen effective DSH directory', async (t) => {
  const home = mkdtempSync(join(tmpdir(), 'sihq-dir-selection-'));
  const userDir = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const previous = process.env[userDir];
  process.env[userDir] = home;
  t.after(() => {
    if (previous === undefined) delete process.env[userDir];
    else process.env[userDir] = previous;
    rmSync(home, { recursive: true, force: true });
  });
  assert.equal(homedir(), home);
  const original = join(home, 'original'),
    worktree = join(home, 'worktree');
  mkdirSync(original);
  mkdirSync(worktree);
  const current = canonicalProjectDirectory(worktree);
  let effective = current;
  const agent = { id: 'test-session', session: { header: { cwd: original } } };
  const calls = [],
    routes = new Map();
  let command, scheduledJob;
  const services = {
    agentPresets: { resolve: async (id) => ({ id }) },
    agents: { get: (id) => (id === agent.id ? agent : undefined) },
    workingDirectory: { get: () => effective, ensure: async () => effective },
    jobs: {
      start(spec) {
        scheduledJob = spec;
        return 'fixture-job';
      },
    },
    subagents: {
      getProvider(name) {
        if (name === 'spawn') return { capabilities: { agentPreset: true, outputSchema: true } };
      },
      async startActivation(spec) {
        calls.push(spec.cwd);
        return {
          childId: 'fixture-' + calls.length,
          result: Promise.resolve({
            stopReason: 'completed',
            structured: { summary: 'fixture', evidence: ['e'] },
          }),
          dispose() {},
        };
      },
    },
  };
  const ctx = {
    get: (key) => services[key],
    inject(names, callback) {
      if (names.includes('connection'))
        callback({
          connection: {
            fetch: {
              register(route) {
                routes.set(route.path, route);
              },
            },
          },
        });
    },
    commands: {
      register(value) {
        command = value;
      },
    },
  };
  const sample = {
    id: 'workspace-test',
    name: 'Workspace test',
    steps: ['a', 'b'].map((id) => ({
      id,
      name: id,
      kind: 'read',
      backend: 'spawn',
      instructions: 'Read only.',
    })),
  };
  apply(ctx, { templates: [sample] });
  async function rpc(method, params) {
    const route = routes.get('/api/sihqCatalog/' + method);
    const response = await route.fetch({
      json: async () => ({
        rpcId: 'qa',
        payload: { sessionId: agent.id, ...params },
      }),
    });
    return (await response.json()).result;
  }
  function launch(token) {
    return command.handler({ agent, rawInput: JSON.stringify(['launch', token, 'Inspect.']) });
  }
  const prepared = await rpc('prepareLaunch', { selected: sample.id });
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const { token, cwd } = prepared.value;
  assert.equal(cwd, current);
  effective = original;
  assert.match((await launch(token)).text, /工作目录已改变/);
  assert.equal(scheduledJob, undefined);
  effective = current;
  assert.equal((await launch(token)).kind, 'success');
  effective = original;
  const result = await scheduledJob.run({ append() {}, updateProgress() {} }).done;
  assert.equal(result.status, 'completed', result.detail);
  assert.deepEqual(calls, [current, current]);
  assert.equal((await rpc('runHistory')).value.total, 0);
  effective = current;
  const { value: page } = await rpc('runHistory');
  assert.equal(page.total, 1);
  assert.equal(page.items[0].cwd, current);
  assert.equal((await rpc('runDetail', { id: page.items[0].id })).ok, true);
  effective = original;
  assert.equal((await rpc('runDetail', { id: page.items[0].id })).ok, false);
});
