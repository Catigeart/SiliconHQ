import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { atomicJson } from './atomic.js';
import { ownerAlive, processIdentity, type ProcessIdentity } from '../runtime/identity.js';
import { fault } from '../runtime/faults.js';

type Owner = ProcessIdentity & { token?: string };
function readOwner(text: string): Owner {
  const value = JSON.parse(text);
  const owner = typeof value === 'number' ? { pid: value } : value;
  if (!owner || !Number.isInteger(owner.pid) || owner.pid <= 0)
    throw new Error('运行锁损坏，请检查记录目录');
  return owner;
}
function databaseOwner(db: DatabaseSync): Owner | undefined {
  const row = db.prepare('SELECT value FROM owner WHERE id=1').get() as
    | { value: string }
    | undefined;
  return row && readOwner(row.value);
}
function legacyOwner(file: string): Owner | undefined {
  try {
    return readOwner(readFileSync(file, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

// Inspection never creates the database, repairs rows, or acquires the workflow lock.
// The resume command still acquires its normal lock after a user clicks the button.
export function hasLiveLock(file: string): boolean {
  if (existsSync(file + '.sqlite')) {
    const db = new DatabaseSync(file + '.sqlite', { readOnly: true });
    try {
      if (db.prepare("SELECT 1 FROM sqlite_schema WHERE name='owner' AND type='table'").get()) {
        const owner = databaseOwner(db);
        if (owner && ownerAlive(owner)) return true;
      }
    } finally {
      db.close();
    }
  }
  const owner = legacyOwner(file);
  return !!owner && ownerAlive(owner);
}
export function lockFile(file: string, identity: ProcessIdentity = processIdentity()): () => void {
  const db = new DatabaseSync(file + '.sqlite');
  const owner = { ...identity, token: randomUUID() };
  const transaction = (fn: () => void) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      fn();
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  };
  try {
    db.exec(
      'PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);',
    );
    transaction(() => {
      const old = databaseOwner(db);
      if (old && ownerAlive(old)) throw fault('resource', 'LOCKED', '该任务正在运行，不能同时恢复');
      // Respect locks from versions that did not have the transactional owner row.
      const legacy = legacyOwner(file);
      if (legacy && ownerAlive(legacy))
        throw fault('resource', 'LOCKED', '该任务正在运行，不能同时恢复');
      db.prepare('INSERT OR REPLACE INTO owner VALUES (1, ?)').run(JSON.stringify(owner));
      atomicJson(file, owner);
    });
  } catch (error) {
    db.close();
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      transaction(() => {
        if (databaseOwner(db)?.token === owner.token) {
          if (legacyOwner(file)?.token === owner.token) rmSync(file);
          db.prepare('DELETE FROM owner WHERE id=1').run();
        }
      });
    } finally {
      db.close();
    }
  };
}
