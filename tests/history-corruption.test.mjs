import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { listWorkflowPage } from '../dist/storage/workflow-history.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'sihq-history-corrupt-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  function record() {
    const id = randomUUID();
    const dir = join(root, id);
    mkdirSync(dir);
    const flow = {
      id,
      cwd,
      updatedAt: '2026-11-22',
      prompt: 'task',
      status: 'passed',
      stage: 'review',
    };
    writeFileSync(join(dir, 'workflow.json'), JSON.stringify(flow));
    return { dir, flow };
  }
  return { root, cwd, record };
}

test('history isolates malformed legacy SQLite JSON without falling back to its stale export', (t) => {
  const { root, cwd, record } = setup(t);
  const good = record();
  const broken = record();
  const db = new DatabaseSync(join(broken.dir, 'runtime.sqlite'));
  try {
    db.exec('CREATE TABLE checkpoints(name TEXT PRIMARY KEY, value TEXT NOT NULL)');
    db.prepare('INSERT INTO checkpoints VALUES (?, ?)').run('workflow.json', '{');
  } finally {
    db.close();
  }
  const page = listWorkflowPage(root, cwd);
  assert.deepEqual(
    page.items.map((item) => item.id),
    [good.flow.id],
  );
  assert.equal(page.total, 1);
});

test('history still reports unrelated SQLite schema errors', (t) => {
  const { root, cwd, record } = setup(t);
  const broken = record();
  const db = new DatabaseSync(join(broken.dir, 'runtime.sqlite'));
  try {
    db.exec('CREATE TABLE checkpoints(name TEXT PRIMARY KEY)');
  } finally {
    db.close();
  }
  assert.throws(() => listWorkflowPage(root, cwd), { code: 'ERR_SQLITE_ERROR' });
});
