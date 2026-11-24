import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { WorkflowStore } from '../dist/storage/workflows.js';

test('workflow history pages are scoped, stable, and load summaries from SQLite and legacy JSON', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sihq-history-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const project = join(dir, 'project'),
    other = join(dir, 'other');
  mkdirSync(project);
  mkdirSync(other);
  const root = join(dir, 'history'),
    store = new WorkflowStore(root);
  const current = store.create('x'.repeat(500), project, 1, {
    session: 's1',
    template: { name: 'Test workflow' },
  });
  const sibling = store.create('same project', project, 1, { session: 's2' });
  store.create('another project', other, 1, { session: 's1' });
  // Exports may lag an already committed checkpoint.
  writeFileSync(join(root, current.id, 'workflow.json'), '{}');
  const id = randomUUID();
  mkdirSync(join(root, id));
  writeFileSync(
    join(root, id, 'workflow.json'),
    JSON.stringify({ ...sibling, id, prompt: 'legacy', dsh: undefined }),
  );
  const broken = join(root, randomUUID());
  mkdirSync(broken);
  writeFileSync(join(broken, 'workflow.json'), '{');
  const summaryReads = t.mock.method(DatabaseSync.prototype, 'prepare');
  const scans = () =>
    summaryReads.mock.calls.filter((c) =>
      c.arguments[0].includes("type='table' AND name='checkpoints'"),
    ).length;
  const first = store.listPage(project, { limit: 1 });
  assert.equal(scans(), 3);
  const second = store.listPage(project, {
    offset: first.nextOffset,
    limit: 2,
  });
  assert.equal(first.total, 3);
  assert.equal(second.nextOffset, null);
  assert.deepEqual(
    new Set([...first.items, ...second.items].map((i) => i.id)),
    new Set([current.id, sibling.id, id]),
  );
  const same = store.listPage(project, { session: 's1' }).items;
  assert.equal(scans(), 3, 'paging and changing session share the index');
  assert.equal(same.length, 1);
  assert.equal(same[0].id, current.id);
  assert.equal(same[0].templateName, 'Test workflow');
  assert.equal(same[0].prompt.length, 240);
  assert.equal(same[0].steps, undefined);
  const changed = store.read(current.id);
  changed.prompt = 'updated';
  store.save(changed);
  const before = scans();
  assert.equal(
    new WorkflowStore(root).listPage(project, { session: 's1' }).items[0].prompt,
    'updated',
  );
  assert.equal(scans() - before, 1, 'only a changed database should be reopened');
  assert.throws(() => store.listPage(project, { limit: 0 }), /分页/);
});
