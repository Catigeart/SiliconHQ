import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { fault } from '../runtime/faults.js';
import { isAbsolute, join } from 'node:path';
import { dataDirectory } from './files.js';
import { readWorkflowProjection, workflowFileStamp } from './workflow-history.js';

type Workspace = { path: string; git: boolean; cwd?: string };
type Pending = {
  flowId: string;
  runId: string;
  jobId: string;
  path: string;
  git: number;
  cwd: string | null;
};
const insert =
  'INSERT INTO verification_stops(flowId,runId,jobId,path,git,cwd) VALUES (?,?,?,?,?,?) ' +
  'ON CONFLICT(flowId,jobId) DO UPDATE SET cwd=excluded.cwd WHERE verification_stops.cwd IS NULL AND verification_stops.runId=excluded.runId';

function legacyStops(dir: string, id: string): { cwd: string; runId: string; jobId: string }[] {
  type Row = { cwd: string; runId: string; jobId: string };
  try {
    const rows = readWorkflowProjection(dir, (source) => {
      // A newer or damaged journal may still have a readable workflow export.
      if (
        source
          .prepare(
            "SELECT count(*) AS n FROM pragma_table_info('checkpoints') WHERE name IN ('name','value')",
          )
          .get()?.n !== 2
      )
        return;
      if (
        !source
          .prepare("SELECT 1 FROM checkpoints WHERE name='workflow.json' AND json_valid(value)")
          .get()
      )
        return;
      return source
        .prepare(
          `
        SELECT json_extract(w.value,'$.cwd') AS cwd, json_extract(s.value,'$.runId') AS runId,
          json_extract(s.value,'$.stoppingJobId') AS jobId FROM checkpoints w,
          json_each(CASE WHEN json_valid(w.value) THEN w.value END,'$.steps') s
        WHERE w.name='workflow.json' AND json_valid(w.value) AND json_extract(w.value,'$.id')=? AND s.type='object' AND json_type(w.value,'$.cwd')='text' AND json_type(s.value,'$.runId')='text'
          AND json_type(s.value,'$.stoppingJobId')='text'`,
        )
        .all(id) as Row[];
    });
    if (rows) return rows;
  } catch (error) {
    if (![11, 26].includes((error as { errcode?: number }).errcode ?? 0)) throw error;
  }
  // JSON-only restorations and unreadable SQLite files can still have a valid export.
  const path = join(dir, 'workflow.json');
  if (!existsSync(path)) return [];
  const text = readFileSync(path, 'utf8');
  if (!text.includes('"stoppingJobId"')) return [];
  let flow;
  try {
    flow = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return [];
    throw error;
  }
  if (flow?.id !== id || typeof flow.cwd !== 'string' || !Array.isArray(flow.steps)) return [];
  return flow.steps
    .filter(
      (step: { stoppingJobId?: string; runId?: string }) =>
        typeof step?.stoppingJobId === 'string' && typeof step.runId === 'string',
    )
    .map((step: { runId: string; stoppingJobId: string }) => ({
      cwd: flow.cwd,
      runId: step.runId,
      jobId: step.stoppingJobId,
    }));
}

function sources() {
  const root = dataDirectory('workflows');
  const stamps = new Map<string, string>();
  for (const entry of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (entry.isDirectory() && /^[a-f0-9-]{36}$/i.test(entry.name))
      stamps.set(entry.name, workflowFileStamp(join(root, entry.name)));
  }
  return stamps;
}

const ownerName = 'workflow-owner.json';
function journalIdentity(dir: string) {
  const stat = statSync(join(dir, 'runtime.sqlite'), { bigint: true, throwIfNoEntry: false });
  return stat && stat.ino !== 0n ? [stat.dev, stat.ino, stat.birthtimeNs].join(':') : undefined;
}

// Store a small ownership checkpoint in the same transaction as the workflow.
// The journal's normal export queue publishes it. A copied/replaced database
// must establish its own binding before a busy read can be attributed to it.
export function checkpointWorkflowOwner(db: DatabaseSync, dir: string, id: string, cwd: string) {
  const journal = journalIdentity(dir);
  if (!journal) return;
  const changed = db
    .prepare(
      'INSERT INTO checkpoints(name,value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value WHERE checkpoints.value<>excluded.value',
    )
    .run(ownerName, JSON.stringify({ id, cwd, journal })).changes;
  if (changed) db.prepare('INSERT OR IGNORE INTO pending_exports VALUES (?)').run(ownerName);
}

function exportedOwner(dir: string, id: string): string | undefined {
  try {
    const owner = JSON.parse(readFileSync(join(dir, ownerName), 'utf8'));
    if (
      owner?.id === id &&
      owner.journal &&
      owner.journal === journalIdentity(dir) &&
      typeof owner.cwd === 'string' &&
      isAbsolute(owner.cwd)
    )
      return owner.cwd;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error;
  }
}

// Probe restored journals before taking the shared write transaction. Inside it
// recheck the inventory, the stamps and the import ledger before publishing.
export function prepareWorkspaceStops(
  db: DatabaseSync,
  locate: (cwd: string) => Workspace,
  overlaps: (candidate: Workspace) => boolean,
) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS verification_stops(flowId TEXT, runId TEXT, jobId TEXT, path TEXT, git INTEGER, cwd TEXT, PRIMARY KEY(flowId,jobId));' +
      'CREATE TABLE IF NOT EXISTS verification_sources(flowId TEXT PRIMARY KEY, stamp TEXT NOT NULL)',
  );
  const hasCwd = () =>
    db.prepare("SELECT 1 FROM pragma_table_info('verification_stops') WHERE name='cwd'").get();
  if (!hasCwd()) {
    db.exec('BEGIN IMMEDIATE');
    try {
      if (!hasCwd()) {
        db.exec(
          'ALTER TABLE verification_stops ADD COLUMN cwd TEXT; DELETE FROM verification_sources',
        );
      }
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }
  const inventory = sources();
  const source = db.prepare('SELECT stamp FROM verification_sources WHERE flowId=?');
  const changes = new Map<string, Pending[]>();
  for (const [id, stamp] of inventory) {
    if (source.get(id)?.stamp === stamp) continue;
    const dir = dataDirectory('workflows', id);
    try {
      const rows = legacyStops(dir, id).map(({ cwd, runId, jobId }) => {
        const ws = existsSync(cwd) ? locate(cwd) : { path: cwd, git: false };
        return { flowId: id, runId, jobId, path: ws.path, git: Number(ws.git), cwd: ws.cwd ?? cwd };
      });
      changes.set(id, rows);
    } catch (error) {
      if (![5, 6].includes(((error as { errcode?: number }).errcode ?? 0) & 255)) throw error;
      const owner = exportedOwner(dir, id);
      if (!owner || overlaps(existsSync(owner) ? locate(owner) : { path: owner, git: false }))
        throw fault(
          'resource',
          'LOCKED',
          owner
            ? '本项目的流程数据库正被占用，请稍后重试'
            : '旧流程或恢复后的数据库正被占用，暂时无法确认所属项目，请稍后重试',
        );
      // An unrelated busy journal stays eligible for inspection on the next admission.
    }
  }
  return () => {
    const live = sources();
    for (const [id, stamp] of live) {
      if (inventory.get(id) === stamp) continue;
      const owner = exportedOwner(dataDirectory('workflows', id), id);
      if (!owner || overlaps(existsSync(owner) ? locate(owner) : { path: owner, git: false }))
        throw fault('resource', 'LOCKED', '本项目的流程记录正在更新，请重试');
      changes.delete(id);
    }
    const add = db.prepare(insert);
    const scanned = db.prepare('INSERT OR REPLACE INTO verification_sources VALUES (?,?)');
    for (const [id, rows] of changes) {
      const stamp = inventory.get(id)!;
      if (source.get(id)?.stamp === stamp) continue;
      for (const row of rows) add.run(id, row.runId, row.jobId, row.path, row.git, row.cwd);
      scanned.run(id, stamp);
    }
    return db.prepare('SELECT * FROM verification_stops').all() as Pending[];
  };
}

// The owning template holds the workspace lease throughout these writes.
export function verificationStops(workspace: Workspace, flowId: string) {
  function access<T>(fn: (db: DatabaseSync) => T) {
    const db = new DatabaseSync(dataDirectory('workspace-locks', 'admission.sqlite'));
    try {
      db.exec('PRAGMA busy_timeout=5000');
      return fn(db);
    } finally {
      db.close();
    }
  }
  return {
    pending: () =>
      access(
        (db) =>
          db
            .prepare('SELECT runId,jobId FROM verification_stops WHERE flowId=?')
            .all(flowId) as Pick<Pending, 'runId' | 'jobId'>[],
      ),
    remember: (runId: string, jobId: string) =>
      access((db) =>
        db
          .prepare(insert)
          .run(
            flowId,
            runId,
            jobId,
            workspace.path,
            Number(workspace.git),
            workspace.cwd ?? workspace.path,
          ),
      ),
    confirmed: (jobId: string) =>
      access((db) =>
        db.prepare('DELETE FROM verification_stops WHERE flowId=? AND jobId=?').run(flowId, jobId),
      ),
  };
}
