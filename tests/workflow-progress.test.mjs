import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { WorkflowStore } from '../dist/storage/workflows.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sihq-progress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = new WorkflowStore(join(dir, 'flows'));
  const flow = store.create('example', dir, 1, {
    session: 'fake',
    template: {
      id: 'test',
      name: 'Fixture',
      steps: [
        {
          id: 'a',
          name: 'A',
          kind: 'read',
          instructions: 'private instructions',
          backend: 'spawn',
        },
      ],
    },
  });
  return { store, flow };
}
function completed(report) {
  return {
    stage: 'read',
    node: 'a',
    runId: randomUUID(),
    startedAt: new Date().toISOString(),
    status: 'completed',
    prompt: 'assembled input',
    report,
    input: 'private attachment',
  };
}

test('progress excludes full artifacts while actual steps remain retrievable by round and position', (t) => {
  const { store, flow } = fixture(t);
  const older = completed({ summary: 'original', evidence: ['first'] });
  const report = { summary: 'y'.repeat(300), evidence: ['x'.repeat(72000)] };
  flow.rounds = [{ ...flow, round: 1, steps: [older] }];
  flow.round = 2;
  flow.steps = [completed(report), completed({ summary: 'sibling' })];
  store.save(flow);
  const { flow: progress, revision } = store.readProgress(flow.id);
  assert.equal(store.readProgress(flow.id).revision, revision);
  assert.equal(progress.dsh.session, flow.dsh.session);
  assert.equal(progress.steps[0].reportSummary.length, 240);
  assert.ok(progress.steps[0].reportAvailable);
  assert.ok(JSON.stringify(progress).length < 4000);
  assert.doesNotMatch(
    JSON.stringify(progress),
    /assembled input|private instructions|private attachment/,
  );
  assert.deepEqual(store.readStep(flow.id, 2, 0), flow.steps[0]);
  assert.deepEqual(store.readStep(flow.id, 2, 1), flow.steps[1]);
  assert.deepEqual(store.readStep(flow.id, 1, 0), older);
  assert.throws(() => store.readStep(flow.id, 1, 1));
  assert.throws(() => store.readStep(flow.id, 3, 0));
  assert.throws(() => store.readStep(flow.id, 1, -1));
});

test('an old writer invalidates the derived checkpoint; legacy JSON reads do not migrate', (t) => {
  const { store, flow } = fixture(t);
  const original = store.readProgress(flow.id);
  flow.steps = [completed({ summary: 'finished' })];
  flow.status = 'completed';
  const db = new DatabaseSync(join(store.directory(flow.id), 'runtime.sqlite'));
  try {
    db.prepare("INSERT OR REPLACE INTO checkpoints VALUES ('workflow.json', ?)").run(
      JSON.stringify(flow),
    );
    const updated = store.readProgress(flow.id);
    assert.notEqual(updated.revision, original.revision);
    assert.equal(updated.flow.status, 'completed');
    assert.equal(store.readProgress(flow.id).revision, updated.revision);
    assert.equal(
      db.prepare("SELECT name FROM checkpoints WHERE name='progress-v1'").get(),
      undefined,
    );
    assert.deepEqual(store.readStep(flow.id, 1, 0), flow.steps[0]);
  } finally {
    db.close();
  }
  const id = randomUUID();
  const directory = store.directory(id);
  mkdirSync(directory);
  writeFileSync(join(directory, 'workflow.json'), JSON.stringify({ ...flow, id }));
  assert.equal(store.readProgress(id).flow.steps[0].reportSummary, 'finished');
  assert.deepEqual(store.readStep(id, 1, 0), flow.steps[0]);
  assert.equal(existsSync(join(directory, 'runtime.sqlite')), false);
});

test('migrate an inline DSH history on save and keep immutable archive exports and progress across saves', (t) => {
  const { store, flow } = fixture(t);
  const dir = store.directory(flow.id);
  const old = {
    ...flow,
    round: 1,
    steps: [completed({ summary: 'old-report', text: 'z'.repeat(80000) })],
  };
  Object.assign(flow, { rounds: [old], round: 2, prompt: 'current' });
  const db = new DatabaseSync(join(dir, 'runtime.sqlite'));
  try {
    db.prepare("UPDATE checkpoints SET value=? WHERE name='workflow.json'").run(
      JSON.stringify(flow),
    );
    assert.deepEqual(store.read(flow.id).rounds[0], old);
    const inline = store.readCurrent(flow.id);
    assert.deepEqual(inline.rounds, [old]);
    store.save(inline);
    const head = store.readCurrent(flow.id);
    assert.deepEqual(head.rounds, []);
    assert.equal(head.archivedRounds, 1);
    store.save(head);
    assert.deepEqual(store.read(flow.id).rounds[0], old);
    store.save(store.read(flow.id));
    const mirror = readFileSync(join(dir, 'workflow.json'), 'utf8');
    assert.equal(JSON.parse(mirror).archivedRounds, 1);
    assert.ok(mirror.length < 4000);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'round-1.json'), 'utf8')), old);
    db.exec(
      "CREATE TRIGGER immutable BEFORE INSERT ON checkpoints WHEN NEW.name='round-1.json' BEGIN SELECT RAISE(ABORT, 'already archived'); END",
    );
    store.save(store.read(flow.id));
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
    const current = store.readProgress(flow.id, 0, true);
    assert.deepEqual(current.flow.rounds, []);
    assert.deepEqual(
      current.headings.map((r) => r.round),
      [1, 2],
    );
    assert.equal(store.readProgressHead(flow.id).revision, current.revision);
    assert.equal(
      store.readProgress(flow.id, 1).flow.rounds[0].steps[0].reportSummary,
      'old-report',
    );
    assert.deepEqual(store.readStep(flow.id, 1, 0), old.steps[0]);
    assert.equal(store.readProgress(flow.id).flow.rounds[0].steps[0].reportSummary, 'old-report');
  } finally {
    db.close();
  }
  const jsonStore = new WorkflowStore(join(dir, 'mirror-only'));
  const jsonDir = jsonStore.directory(flow.id);
  mkdirSync(jsonDir, { recursive: true });
  for (const name of ['workflow.json', 'round-1.json'])
    writeFileSync(join(jsonDir, name), readFileSync(join(dir, name)));
  assert.deepEqual(jsonStore.read(flow.id).rounds[0], old);
  jsonStore.save(jsonStore.readCurrent(flow.id));
  assert.deepEqual(jsonStore.readStep(flow.id, 1, 0), old.steps[0]);
});
