import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  rmSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJson, lockFile } from '../dist/storage/files.js';
import { parseCommand } from '../dist/commands/parse.js';
import { KernelStore, budgetSchema } from '../dist/kernel/store.js';
import { runKernel } from '../dist/kernel/runner.js';
import { readModelArtifact, readEvidence } from '../dist/kernel/artifacts.js';
import { recoveryAction, runWorkflow } from '../dist/workflow/runner.js';
import { RunStore } from '../dist/storage/runs.js';
import { WorkflowStore } from '../dist/storage/workflows.js';

function temporary(fn) {
  const root = mkdtempSync(join(tmpdir(), 'sihq-refactor-'));
  return Promise.resolve()
    .then(() => fn(root))
    .finally(() => rmSync(root, { recursive: true, force: true }));
}
function kernelFixture(root) {
  const store = new KernelStore(root),
    id = randomUUID();
  mkdirSync(store.dir(id));
  const role = { model: 'fixture', reasoningEffort: 'medium', speed: 'inherit' };
  const state = {
    id,
    project: root,
    createdAt: 'now',
    updatedAt: 'now',
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
    parent: root,
    threads: {},
    attempts: {},
    results: [],
  };
  store.save(state);
  return { store, id, state };
}
test('atomic writes preserve old data and remove temporary files when serialization fails', () =>
  temporary((root) => {
    const file = join(root, 'record.json');
    atomicJson(file, { ok: true });
    const circular = {};
    circular.self = circular;
    assert.throws(() => atomicJson(file, circular));
    assert.deepEqual(JSON.parse(readFileSync(file)), { ok: true });
    assert.deepEqual(readdirSync(root), ['record.json']);
  }));
test('lock exclusion and idempotent release do not remove a subsequent lock', () =>
  temporary((root) => {
    const file = join(root, 'lock'),
      release = lockFile(file);
    assert.throws(() => lockFile(file), /正在运行/);
    release();
    const second = lockFile(file);
    release();
    assert.ok(existsSync(file));
    second();
  }));
test('kernel migrates unversioned state and rejects corrupt or future records', () =>
  temporary((root) => {
    const { store, id, state } = kernelFixture(root);
    delete state.schemaVersion;
    const file = join(store.dir(id), 'state.json');
    atomicJson(file, state);
    assert.equal(store.read(id).schemaVersion, 1);
    assert.equal(JSON.parse(readFileSync(file)).schemaVersion, undefined);
    for (const patch of [
      { schemaVersion: 2 },
      { stage: 'bogus' },
      { calls: -1 },
      { id: randomUUID() },
    ]) {
      atomicJson(file, { ...state, ...patch });
      assert.throws(() => store.read(id));
    }
  }));
for (const failure of ['read', 'start', 'finish', 'event'])
  test(`kernel releases locks and signal handlers after ${failure} failure`, () =>
    temporary(async (root) => {
      const { store, id } = kernelFixture(root);
      const signals = ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name));
      if (failure === 'read') writeFileSync(join(store.dir(id), 'state.json'), '{');
      if (failure === 'start')
        store.save = () => {
          throw new Error('start failed');
        };
      if (failure === 'finish') {
        atomicJson(join(store.dir(id), 'control.json'), { action: 'pause' });
        const save = store.save.bind(store);
        store.save = (s) => {
          if (!s.workerPid) throw new Error('finish failed');
          save(s);
        };
      }
      if (failure === 'event') {
        atomicJson(join(store.dir(id), 'control.json'), { action: 'pause' });
        store.event = () => {
          throw new Error('event failed');
        };
      }
      await assert.rejects(runKernel(id, store));
      assert.ok(!existsSync(join(store.dir(id), 'lock')));
      assert.deepEqual(
        ['SIGINT', 'SIGTERM'].map((name) => process.listenerCount(name)),
        signals,
      );
    }));
test('cached model and validation reports are checked before reuse', () =>
  temporary((root) => {
    const file = join(root, 'cached.json');
    atomicJson(file, { verdict: 'passed' });
    assert.throws(() => readModelArtifact(file, 'review'));
    atomicJson(file, { passed: 'true', source: {} });
    assert.throws(() => readEvidence(file));
    atomicJson(file, { verdict: 'passed', summary: 'ok', findings: [], limitations: [] });
    assert.equal(readModelArtifact(file, 'review').verdict, 'passed');
  }));
test('CLI parser preserves native forwarding and validates owned commands', () => {
  assert.deepEqual(parseCommand(['--help'], '/tmp'), { kind: 'interactive' });
  assert.deepEqual(parseCommand(['resume', '--last'], '/tmp'), { kind: 'interactive' });
  assert.equal(
    parseCommand(['workflow', 'request', '--max-repairs', '0'], '/tmp').request.maxRepairs,
    0,
  );
  assert.throws(() => parseCommand(['workflow', 'request', '--max-repairs', '3'], '/tmp'));
  assert.throws(() => parseCommand(['list', '--fast'], '/tmp'));
  assert.equal(parseCommand(['review', 'id', '--fast'], '/tmp').request.sourceId, 'id');
});
test('workflow recovery never reuses the previous repair execution', () => {
  const run = { status: 'completed', executionId: 'old' };
  assert.equal(recoveryAction({ stage: 'repair', executionId: 'new' }, run), 'execute');
  assert.equal(recoveryAction({ stage: 'repair' }, run), 'execute');
  assert.equal(recoveryAction({ stage: 'review', executionId: 'old' }, run), 'reuse');
  assert.equal(recoveryAction({ stage: 'review', executionId: 'old' }, run, true), 'execute');
});
test('workflow uses injected storage and executor and releases locks on failure', () =>
  temporary(async (root) => {
    const runs = new RunStore(join(root, 'runs')),
      flows = new WorkflowStore(join(root, 'flows'));
    let called = false;
    const flow = await runWorkflow(
      'test',
      root,
      new AbortController().signal,
      0,
      { log() {}, renderEvent() {}, onUpdate() {}, onStage() {} },
      undefined,
      {
        runs,
        flows,
        async executeTask(store, run) {
          called = true;
          assert.equal(store, runs);
          assert.ok(runs.read(run.id));
          throw new Error('injected failure');
        },
      },
    );
    assert.equal(called, true);
    assert.equal(flow.status, 'failed');
    assert.match(flow.error, /injected failure/);
    assert.ok(!existsSync(join(flows.directory(flow.id), 'lock')));
  }));
