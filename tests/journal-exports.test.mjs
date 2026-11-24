import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { Journal } from '../dist/runtime/journal.js';
import { RunStore } from '../dist/storage/runs.js';
import { WorkflowStore } from '../dist/storage/workflows.js';
import { runTemplate } from '../template-runner.js';

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'sihq-exports-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a blocked workflow mirror leaves the approval committed and a delayed retry publishes its result', async (t) => {
  const root = directory(t);
  const home = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const original = process.env[home];
  process.env[home] = root;
  t.after(() => {
    if (original === undefined) delete process.env[home];
    else process.env[home] = original;
  });
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const flows = new WorkflowStore(join(root, 'flows'));
  const runs = new RunStore(join(root, 'runs'));
  const gate = {
    id: 'confirm',
    kind: 'approval',
    name: 'Approve',
    instructions: 'Review',
    inputs: [],
  };
  const run = (request) =>
    runTemplate({
      request,
      cwd,
      flows,
      runs,
      globalBudget: 1,
      frozen: { session: 's', template: { id: 't', name: 'Gate', steps: [gate] } },
      signal: new AbortController().signal,
      observer: { onUpdate() {}, log() {} },
      delegate() {
        throw Error('approval must not call an agent');
      },
    });
  const waiting = await run({ action: 'start', prompt: 'Please confirm' });
  const mirror = join(flows.directory(waiting.id), 'workflow.json');
  renameSync(mirror, mirror + '.previous');
  mkdirSync(mirror);
  const request = {
    action: 'approve',
    id: waiting.id,
    approvalId: waiting.pendingApproval.id,
    note: 'ok',
  };
  assert.equal((await run(request)).status, 'completed');
  const committed = flows.read(waiting.id);
  assert.equal(committed.steps[0].report.decision, 'approved');
  assert.equal(committed.pendingApproval, undefined);
  await assert.rejects(run(request), /确认已失效/);
  rmdirSync(mirror);
  for (let retry = 0; retry < 60 && !existsSync(mirror); retry++) await delay(100);
  assert.deepEqual(JSON.parse(readFileSync(mirror, 'utf8')).steps, committed.steps);
});

test('the next checkpoint repairs durable pending exports using the latest value', (t) => {
  const dir = directory(t);
  const file = join(dir, 'state.json');
  const first = new Journal(dir);
  assert.deepEqual(first.checkpoint('state.json', { rev: 1 }), { exportsPending: false });
  renameSync(file, file + '.old');
  mkdirSync(file);
  assert.deepEqual(first.checkpoint('state.json', { rev: 2 }), { exportsPending: true });
  assert.deepEqual(first.checkpoint('state.json', { rev: 3 }), { exportsPending: true });
  rmdirSync(file);
  const reopened = new Journal(dir);
  assert.deepEqual(reopened.checkpoint('other.json', { ok: true }), { exportsPending: false });
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { rev: 3 });
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'other.json'), 'utf8')), { ok: true });
});

test('explicit repair rebuilds missing exports from a legacy SQLite journal without exporting derived rows', (t) => {
  const dir = directory(t);
  const journal = new Journal(dir);
  const db = new DatabaseSync(journal.file);
  try {
    db.exec(`CREATE TABLE checkpoints (name TEXT PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO checkpoints VALUES ('workflow.json','{"status":"completed"}'), ('progress-v1','{}');`);
  } finally {
    db.close();
  }
  assert.equal(journal.repairExports(), true);
  assert.equal(JSON.parse(readFileSync(join(dir, 'workflow.json'), 'utf8')).status, 'completed');
  assert.equal(existsSync(join(dir, 'progress-v1')), false);
});
