import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
      const version = db.prepare('PRAGMA user_version').get() as { user_version: number };
      if (version.user_version > 1) throw new Error('执行数据库版本高于当前程序，请升级 sihq');
      db.exec(`CREATE TABLE IF NOT EXISTS checkpoints (name TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations (id TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, operation TEXT, type TEXT NOT NULL, value TEXT NOT NULL);
        PRAGMA user_version=1; BEGIN IMMEDIATE;`);
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
  checkpoint(name: string, value: unknown, operation?: Operation): void {
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
      if (operation) this.put(db, operation, 'checkpoint.committed');
    });
    atomicJson(join(this.directory, name), value);
  }
  readCheckpoint(name: string): unknown {
    if (existsSync(this.file)) {
      const row = this.transaction((db) =>
        db.prepare('SELECT value FROM checkpoints WHERE name=?').get(name),
      ) as { value: string } | undefined;
      if (row) return JSON.parse(row.value);
    }
    return JSON.parse(readFileSync(join(this.directory, name), 'utf8'));
  }
  operation(id: string): Operation | undefined {
    if (!existsSync(this.file)) return undefined;
    const row = this.transaction((db) =>
      db.prepare('SELECT value FROM operations WHERE id=?').get(id),
    ) as { value: string } | undefined;
    return row ? JSON.parse(row.value) : undefined;
  }
  operations(): Operation[] {
    if (!existsSync(this.file)) return [];
    return this.transaction((db) => db.prepare('SELECT value FROM operations').all())
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
