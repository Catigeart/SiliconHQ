import { DatabaseSync } from 'node:sqlite';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory } from './files.js';
import { readWorkflowProjection, workflowFileStamp } from './workflow-history.js';

type Workspace = { path: string; git: boolean };
type Pending = { flowId: string; runId: string; jobId: string; path: string; git: number };
const insert =
  'INSERT OR IGNORE INTO verification_stops(flowId,runId,jobId,path,git) VALUES (?,?,?,?,?)';

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

// An external restore can arrive after this database was initialized. Import new
// evidence under the same transaction that admits writers. Only confirmation
// from the owning flow removes a stop, even if the source record disappears.
export function workspaceStops(db: DatabaseSync, locate: (cwd: string) => Workspace): Pending[] {
  db.exec(
    'CREATE TABLE IF NOT EXISTS verification_stops(flowId TEXT, runId TEXT, jobId TEXT, path TEXT, git INTEGER, PRIMARY KEY(flowId,jobId));' +
      'CREATE TABLE IF NOT EXISTS verification_sources(flowId TEXT PRIMARY KEY, stamp TEXT NOT NULL)',
  );
  const root = dataDirectory('workflows');
  const add = db.prepare(insert);
  const source = db.prepare('SELECT stamp FROM verification_sources WHERE flowId=?');
  const scanned = db.prepare('INSERT OR REPLACE INTO verification_sources VALUES (?,?)');
  for (const entry of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || !/^[a-f0-9-]{36}$/i.test(entry.name)) continue;
    const dir = join(root, entry.name);
    const stamp = workflowFileStamp(dir);
    if (source.get(entry.name)?.stamp === stamp) continue;
    for (const row of legacyStops(dir, entry.name)) {
      const cwd = String(row.cwd);
      const workspace = existsSync(cwd) ? locate(cwd) : { path: cwd, git: false };
      add.run(entry.name, row.runId, row.jobId, workspace.path, Number(workspace.git));
    }
    scanned.run(entry.name, stamp);
  }
  return db.prepare('SELECT * FROM verification_stops').all() as Pending[];
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
        db.prepare(insert).run(flowId, runId, jobId, workspace.path, Number(workspace.git)),
      ),
    confirmed: (jobId: string) =>
      access((db) =>
        db.prepare('DELETE FROM verification_stops WHERE flowId=? AND jobId=?').run(flowId, jobId),
      ),
  };
}
