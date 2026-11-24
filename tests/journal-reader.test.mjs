import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { Journal } from '../dist/runtime/journal.js';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sihq-journal-reader-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return new Journal(dir);
}

test('readers see committed data while a write transaction owns the journal', (t) => {
  const journal = fixture(t);
  const original = { step: 1 };
  const operation = { id: 'step', phase: 'running', updatedAt: 1 };
  journal.checkpoint('workflow.json', original, operation);
  const writer = new DatabaseSync(journal.file);
  try {
    writer.exec('BEGIN IMMEDIATE');
    writer.prepare('UPDATE checkpoints SET value=?').run('{"step":2}');
    writer.prepare('DELETE FROM operations').run();
    assert.deepEqual(journal.readCheckpoint('workflow.json'), original);
    assert.deepEqual(journal.operation('step'), operation);
    assert.deepEqual(journal.operations(), [operation]);
  } finally {
    writer.close();
  }
});

test('missing and uninitialized databases support legacy JSON without creating storage', (t) => {
  const journal = fixture(t);
  writeFileSync(join(journal.directory, 'flow.json'), '{"old":true}');
  const checkLegacy = () => {
    assert.deepEqual(journal.readCheckpoint('flow.json'), { old: true });
    assert.equal(journal.operation('absent'), undefined);
    assert.deepEqual(journal.operations(), []);
  };
  checkLegacy();
  assert.equal(existsSync(journal.file), false);
  const writer = new DatabaseSync(journal.file);
  try {
    checkLegacy();
    assert.equal(writer.prepare('SELECT COUNT(*) AS n FROM sqlite_master').get().n, 0);
    writer.exec('PRAGMA user_version=3');
    assert.throws(checkLegacy, /升级/);
  } finally {
    writer.close();
  }
});

test('a checkpoint projection observes one revision and failed derived writes roll back', (t) => {
  const journal = fixture(t);
  journal.checkpoint('flow.json', 1);
  const observed = journal.queryCheckpoint((db) => {
    const read = db.prepare("SELECT value FROM checkpoints WHERE name='flow.json'");
    const first = read.get().value;
    journal.checkpoint('flow.json', 2);
    return [first, read.get().value];
  });
  assert.deepEqual(observed, ['1', '1']);
  assert.throws(
    () =>
      journal.checkpoint('flow.json', 3, undefined, (db) => {
        assert.equal(
          db.prepare("SELECT value FROM checkpoints WHERE name='flow.json'").get().value,
          '3',
        );
        throw new Error('fixture: derived write failed');
      }),
    /fixture: derived write failed/,
  );
  assert.equal(journal.readCheckpoint('flow.json'), 2);
});
