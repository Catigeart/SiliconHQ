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
function transaction(db: DatabaseSync, fn: () => void, undoMarker?: () => void) {
  db.exec('BEGIN IMMEDIATE');
  try {
    fn();
    db.exec('COMMIT');
  } catch (error) {
    try {
      undoMarker?.();
    } finally {
      db.exec('ROLLBACK');
    }
    throw error;
  }
}
export function lockFile(file: string, identity: ProcessIdentity = processIdentity()): () => void {
  const db = new DatabaseSync(file + '.sqlite');
  const owner = { ...identity, token: randomUUID() };
  let publishing = false;
  try {
    db.exec(
      'PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS owner (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);',
    );
    transaction(
      db,
      () => {
        const old = databaseOwner(db);
        if (old && ownerAlive(old))
          throw fault('resource', 'LOCKED', '该任务正在运行，不能同时恢复');
        // Respect locks from versions that did not have the transactional owner row.
        const legacy = legacyOwner(file);
        if (legacy && ownerAlive(legacy))
          throw fault('resource', 'LOCKED', '该任务正在运行，不能同时恢复');
        db.prepare('INSERT OR REPLACE INTO owner VALUES (1, ?)').run(JSON.stringify(owner));
        publishing = true;
        atomicJson(file, owner);
      },
      () => {
        if (publishing && legacyOwner(file)?.token === owner.token) rmSync(file);
      },
    );
  } finally {
    db.close();
  }
  let released = false;
  let retry: NodeJS.Timeout | undefined;
  let retryDelay = 100;
  function release() {
    if (released) return;
    const db = new DatabaseSync(file + '.sqlite');
    try {
      db.exec('PRAGMA busy_timeout=100');
      let removed = false;
      transaction(
        db,
        () => {
          if (databaseOwner(db)?.token === owner.token) {
            if (legacyOwner(file)?.token === owner.token) {
              rmSync(file);
              removed = true;
            }
            db.prepare('DELETE FROM owner WHERE id=1').run();
          }
        },
        () => {
          if (removed) atomicJson(file, owner);
        },
      );
      released = true;
      clearTimeout(retry);
    } catch (error) {
      const { errcode, code } = error as { errcode?: number; code?: string };
      if (
        !retry &&
        ([5, 6].includes((errcode ?? 0) & 255) || code === 'EBUSY' || code === 'EPERM')
      ) {
        // Most finally blocks drop the release handle after one call. Keep
        // cleaning up while this process (the durable owner) is still alive.
        retry = setTimeout(() => {
          retry = undefined;
          try {
            release();
          } catch (failure) {
            if (!retry) console.warn('[SiliconHQ] 释放运行锁失败', file, failure);
          }
        }, retryDelay);
        retry.unref();
        retryDelay = Math.min(5000, retryDelay * 2);
      }
      throw error;
    } finally {
      db.close();
    }
  }
  return release;
}
