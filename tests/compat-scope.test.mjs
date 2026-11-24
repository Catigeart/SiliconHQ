import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../plugin.js';
import { RunStore } from '../dist/storage/runs.js';
import { ChatStore } from '../dist/storage/chats.js';
import { WorkflowStore } from '../dist/storage/workflows.js';
import { KernelStore, budgetSchema } from '../dist/kernel/store.js';

test('DSH compatibility commands stay in the selected project while the terminal can list all runs', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-compat-scope-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const homeVariable = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const original = process.env[homeVariable];
  process.env[homeVariable] = root;
  t.after(() => {
    if (original === undefined) delete process.env[homeVariable];
    else process.env[homeVariable] = original;
  });
  assert.equal(homedir(), root);
  const runs = new RunStore();
  const chats = new ChatStore();
  const kernels = new KernelStore();
  const flows = new WorkflowStore();
  const role = { model: 'unused', reasoningEffort: 'low' };
  function records(name) {
    const cwd = join(root, name);
    mkdirSync(cwd);
    const run = runs.create(name, cwd);
    // A failed scope check in the resume test must never reach an external Agent.
    run.dshProvider = 'fixture';
    runs.save(run);
    const chat = chats.create(cwd);
    const flow = flows.create(name, cwd);
    const kernelId = randomUUID();
    kernels.save({
      id: kernelId,
      project: cwd,
      createdAt: 'now',
      status: 'ready',
      stage: 'baseline',
      experiment: 1,
      budget: budgetSchema.parse({}),
      usedSeconds: 0,
      calls: 0,
      tokens: 0,
      profile: 'smoke',
      sizes: [32],
      blocks: [1],
      iterations: 1,
      roles: { planner: role, developer: role, reviewer: role },
      parent: cwd,
      threads: {},
      attempts: {},
      results: [],
    });
    return { cwd, run: run.id, chat: chat.id, flow: flow.id, kernel: kernelId };
  }
  const a = records('project-a');
  const b = records('project-b');
  let command;
  apply({
    commands: {
      register(entry) {
        command = entry;
      },
    },
    get(name) {
      if (name === 'workingDirectory') return { ensure: async () => a.cwd };
    },
  });
  const invoke = (args) =>
    command.handler({
      rawInput: JSON.stringify(args),
      agent: { id: 'test-session', session: { header: { cwd: a.cwd } } },
      signal: new AbortController().signal,
    });
  for (const [args, kind] of [
    [['list'], 'run'],
    [['chat', 'list'], 'chat'],
    [['kernel', 'list'], 'kernel'],
  ]) {
    const result = await invoke(args);
    assert.equal(result.kind, 'success', result.text);
    assert.ok(result.text.includes(a[kind]), result.text);
    assert.ok(!result.text.includes(b[kind]), result.text);
  }
  for (const args of [
    ['implement', b.run],
    ['review', b.run],
    ['resume', b.run, 'test'],
    ['kernel', 'experiments', b.kernel],
    ['kernel', 'pause', b.kernel],
    ['kernel', 'start', b.cwd, '--prepare-only'],
  ]) {
    const result = await invoke(args);
    assert.equal(result.kind, 'error', result.text);
    assert.match(result.text, /当前 DSH 项目/);
  }
  assert.equal((await invoke(['workflow', 'status', b.flow])).kind, 'error');
  assert.equal((await invoke(['kernel', 'experiments', a.kernel])).kind, 'success');
  const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
  const terminal = spawnSync(process.execPath, [cli, 'list'], { cwd: a.cwd, encoding: 'utf8' });
  assert.equal(terminal.status, 0, terminal.stderr);
  assert.ok(terminal.stdout.includes(a.run) && terminal.stdout.includes(b.run));
});
