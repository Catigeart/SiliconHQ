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
export function lockFile(file: string): () => void {
  const db = new DatabaseSync(file + '.sqlite');
  const owner = { ...processIdentity(), token: randomUUID() };
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
      const old = db.prepare('SELECT value FROM owner WHERE id=1').get() as
        | { value: string }
        | undefined;
      if (old && ownerAlive(readOwner(old.value)))
        throw fault('resource', 'LOCKED', '该任务正在运行，不能同时恢复');
      // Respect locks from versions that did not have the transactional owner row.
      if (existsSync(file) && ownerAlive(readOwner(readFileSync(file, 'utf8'))))
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
        const row = db.prepare('SELECT value FROM owner WHERE id=1').get() as
          | { value: string }
          | undefined;
        if (row && readOwner(row.value).token === owner.token) {
          if (existsSync(file) && readOwner(readFileSync(file, 'utf8')).token === owner.token)
            rmSync(file);
          db.prepare('DELETE FROM owner WHERE id=1').run();
        }
      });
    } finally {
      db.close();
    }
  };
}
