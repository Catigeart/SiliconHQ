import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { atomicJson } from '../storage/atomic.js';
import type { Failure } from './faults.js';

export type Operation = {
  id: string;
  identity: string;
  phase: 'running' | 'reconciling' | 'recovering' | 'completed' | 'blocked' | 'cancelled';
  attempt: number;
  corrections: number;
  createdAt: number;
  updatedAt: number;
  lastProgressAt: number;
  recoveryStartedAt?: number;
  nextRetryAt?: number;
  failure?: Failure;
  before?: unknown;
  attemptBefore?: unknown;
  after?: unknown;
  result?: unknown;
  provider?: {
    threadId?: string;
    turnId?: string;
    terminal?: unknown;
    version?: string;
    submitted?: boolean;
    usage?: unknown;
    requestId?: string;
  };
};

function journalVersion(db: DatabaseSync): number {
  const { user_version: version } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  if (version > 2) throw new Error('执行数据库版本高于当前程序，请升级 sihq');
  return version;
}

// A blocked export gets another opportunity even when the workflow has already finished.
// Pending names stay in SQLite if the host exits. The next checkpoint also retries them.
const exportRetries = new Map<string, NodeJS.Timeout>();

// One database per run/campaign. JSON files are readable exports, not a second
// source of truth. Legacy records are imported on their first successful save.
export class Journal {
  readonly file: string;
  constructor(readonly directory: string) {
    this.file = join(directory, 'runtime.sqlite');
  }
  transaction<T>(fn: (db: DatabaseSync) => T): T {
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    const db = new DatabaseSync(this.file);
    try {
      db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      db.exec('BEGIN IMMEDIATE');
      if (journalVersion(db) === 0) db.exec('PRAGMA user_version=1');
      db.exec(`CREATE TABLE IF NOT EXISTS checkpoints (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, operation TEXT, type TEXT NOT NULL, value TEXT NOT NULL);`);
      const result = fn(db);
      db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {}
      throw error;
    } finally {
      db.close();
    }
  }
  private read<T>(
    table: 'checkpoints' | 'operations',
    select: (db: DatabaseSync) => T,
  ): T | undefined {
    let db: DatabaseSync;
    try {
      db = new DatabaseSync(this.file, { readOnly: true });
    } catch (error) {
      // A missing record (also when concurrently removed) must not create an empty database.
      if (!statSync(this.file, { throwIfNoEntry: false })) return undefined;
      throw error;
    }
    try {
      // Pin one committed WAL snapshot for all queries in select(); closing releases it.
      db.exec('BEGIN DEFERRED');
      // Version zero also occurs between the first open and schema initialization.
      if (
        journalVersion(db) === 0 &&
        !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)
      )
        return undefined;
      return select(db);
    } finally {
      db.close();
    }
  }
  checkpoint(
    name: string,
    value: unknown,
    operation?: Operation,
    afterWrite?: (db: DatabaseSync) => void,
  ): { exportsPending: boolean } {
    const json = JSON.stringify(value);
    this.transaction((db) => {
      const imported = db.prepare('SELECT 1 FROM checkpoints WHERE name=?').get(name);
      const legacy = join(this.directory, name);
      const backup = join(this.directory, 'legacy-records', name);
      if (!imported && existsSync(legacy) && !existsSync(backup)) {
        mkdirSync(join(this.directory, 'legacy-records'), { recursive: true, mode: 0o700 });
        // Validate the serialized backup before adopting the record.
        atomicJson(backup, JSON.parse(readFileSync(legacy, 'utf8')));
      }
      db.prepare('INSERT OR REPLACE INTO checkpoints VALUES (?, ?)').run(name, json);
      db.exec('CREATE TABLE IF NOT EXISTS pending_exports (name TEXT PRIMARY KEY)');
      afterWrite?.(db);
      if (operation) this.put(db, operation, 'checkpoint.committed');
      db.prepare('INSERT OR IGNORE INTO pending_exports VALUES (?)').run(name);
    });
    return { exportsPending: !this.refreshExports(0) };
  }
  /** Rebuild JSON exports on request, including old journals that did not track failed exports. */
  repairExports(): boolean {
    if (!existsSync(this.file)) return true;
    this.transaction((db) => {
      db.exec(`CREATE TABLE IF NOT EXISTS pending_exports (name TEXT PRIMARY KEY);
        INSERT OR IGNORE INTO pending_exports SELECT name FROM checkpoints WHERE name GLOB '*.json';`);
    });
    return this.refreshExports(0);
  }
  // Publish the latest committed version. Writers serialize so an older mirror cannot win a race.
  private refreshExports(attempt: number): boolean {
    if (!existsSync(this.file)) return true;
    let pending = false;
    try {
      this.transaction((db) => {
        const rows = db
          .prepare(
            'SELECT p.name, c.value FROM pending_exports p JOIN checkpoints c ON c.name=p.name',
          )
          .all();
        const published = db.prepare('DELETE FROM pending_exports WHERE name=?');
        for (const row of rows) {
          const name = String(row.name);
          if (basename(name) !== name || name === '..' || name === '.') {
            pending = true;
            continue;
          }
          try {
            atomicJson(join(this.directory, name), JSON.parse(String(row.value)));
          } catch {
            pending = true;
            continue;
          }
          published.run(name);
        }
      });
    } catch {
      // The authoritative transaction has already committed, including the pending names.
      pending = true;
    }
    const previous = exportRetries.get(this.file);
    if (!pending) {
      if (previous) clearTimeout(previous);
      exportRetries.delete(this.file);
    } else if (!previous && attempt < 5) {
      const timer = setTimeout(
        () => {
          exportRetries.delete(this.file);
          this.refreshExports(attempt + 1);
        },
        1000 * 2 ** attempt,
      );
      exportRetries.set(this.file, timer.unref());
    }
    return !pending;
  }
  queryCheckpoint<T>(read: (db: DatabaseSync) => T): T | undefined {
    return this.read('checkpoints', read);
  }
  readCheckpoint(name: string): unknown {
    const row = this.queryCheckpoint((db) =>
      db.prepare('SELECT value FROM checkpoints WHERE name=?').get(name),
    );
    if (row) return JSON.parse(String(row.value));
    return JSON.parse(readFileSync(join(this.directory, name), 'utf8'));
  }
  operation(id: string): Operation | undefined {
    const row = this.read('operations', (db) =>
      db.prepare('SELECT value FROM operations WHERE id=?').get(id),
    );
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  operations(): Operation[] {
    const rows = this.read('operations', (db) => db.prepare('SELECT value FROM operations').all());
    return (rows ?? [])
      .map((row) => JSON.parse(String(row.value)) as Operation)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }
  save(operation: Operation, event?: string): void {
    operation.updatedAt = Date.now();
    this.transaction((db) => this.put(db, operation, event));
  }
  private put(db: DatabaseSync, operation: Operation, event?: string): void {
    db.prepare('INSERT OR REPLACE INTO operations VALUES (?, ?)').run(
      operation.id,
      JSON.stringify(operation),
    );
    if (event)
      db.prepare('INSERT INTO events (at, operation, type, value) VALUES (?, ?, ?, ?)').run(
        Date.now(),
        operation.id,
        event,
        JSON.stringify(operation),
      );
  }
}
