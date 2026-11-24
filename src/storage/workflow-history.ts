import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectDirectoryKey } from './project-path.js';
import { DatabaseSync } from 'node:sqlite';

export type WorkflowSummary = {
  id: string;
  cwd: string;
  prompt: string;
  status: string;
  stage: string;
  updatedAt: string;
  round: number;
  session: string | null;
  templateName: string | null;
};

// SQLite maintains these compact fields even when an older SiliconHQ client updates
// the workflow. The partial index only covers workflow records.
const projection = {
  id: "json_extract(value, '$.id')",
  cwd: "json_extract(value, '$.cwd')",
  prompt: "substr(json_extract(value, '$.prompt'), 1, 240)",
  status: "json_extract(value, '$.status')",
  stage: "json_extract(value, '$.stage')",
  updatedAt: "json_extract(value, '$.updatedAt')",
  round: "ifnull(json_extract(value, '$.round'),1)",
  session: "json_extract(value, '$.dsh.session')",
  templateName: "json_extract(value, '$.dsh.template.name')",
};
const indexName = 'workflow_listing_v1';
const whereWorkflow = "name='workflow.json'";
const selectFields = Object.entries(projection)
  .map(([alias, sql]) => sql + ' AS ' + alias)
  .join(', ');

export function indexWorkflowSummary(db: DatabaseSync): void {
  db.exec(
    'CREATE INDEX IF NOT EXISTS ' +
      indexName +
      ' ON checkpoints(name, ' +
      Object.values(projection).join(', ') +
      ') WHERE ' +
      whereWorkflow,
  );
}

// Read only the exported checkpoint shape, without opening or migrating a run for execution.
export function readWorkflowProjection<T>(directory: string, read: (db: DatabaseSync) => T) {
  const file = join(directory, 'runtime.sqlite');
  if (existsSync(file)) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      db.exec('PRAGMA busy_timeout=0; BEGIN DEFERRED');
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='checkpoints'").get())
        return read(db);
    } finally {
      db.close();
    }
  }
}

function readSummary(directory: string): WorkflowSummary | undefined {
  const summary = readWorkflowProjection(directory, (db) => {
    // Existing records get the index on their next save. Browsing is read-only.
    const indexed = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND name=?")
      .get(indexName);
    const source = indexed ? 'checkpoints INDEXED BY ' + indexName : 'checkpoints';
    // Legacy databases can contain malformed checkpoint text. The expression index
    // already rejects such writes, so indexed summaries need not parse the full report.
    const filter = indexed ? whereWorkflow : whereWorkflow + ' AND json_valid(value)';
    const row = db.prepare('SELECT ' + selectFields + ' FROM ' + source + ' WHERE ' + filter).get();
    if (row) return row as WorkflowSummary;
    // An invalid authoritative checkpoint must not resurrect its stale JSON export.
    if (!indexed && db.prepare('SELECT 1 FROM checkpoints WHERE ' + whereWorkflow).get())
      return null;
  });
  if (summary !== undefined) return summary ?? undefined;
  const legacy = join(directory, 'workflow.json');
  if (!existsSync(legacy)) return;
  const flow = JSON.parse(readFileSync(legacy, 'utf8'));
  if (!flow || typeof flow !== 'object') return;
  return {
    id: flow.id,
    cwd: flow.cwd,
    prompt: String(flow.prompt).slice(0, 240),
    status: flow.status,
    stage: flow.stage,
    updatedAt: flow.updatedAt,
    round: flow.round ?? 1,
    session: flow.dsh?.session ?? null,
    templateName: flow.dsh?.template?.name ?? null,
  };
}

export type HistoryPageOptions = {
  session?: string;
  offset?: number;
  limit?: number;
};

type CachedRow = { stamp: string; row?: WorkflowSummary };
type HistoryIndex = {
  records: Map<string, CachedRow>;
  pages: Map<string, WorkflowSummary[]>;
  paths: Map<string, string>;
};
const indexes = new Map<string, HistoryIndex>();
function fileStamp(path: string) {
  const stat = statSync(path, { bigint: true, throwIfNoEntry: false });
  // Opening a read-only WAL database can create an empty WAL without changing its data.
  if (path.endsWith('-wal') && stat?.size === 0n) return '';
  return stat ? [stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':') : '';
}
export function workflowFileStamp(dir: string) {
  return ['runtime.sqlite', 'runtime.sqlite-wal', 'workflow.json']
    .map((file) => fileStamp(join(dir, file)))
    .join('|');
}
function refreshIndex(root: string) {
  root = resolve(root);
  let index = indexes.get(root);
  if (!index) {
    index = { records: new Map(), pages: new Map(), paths: new Map() };
    indexes.set(root, index);
    if (indexes.size > 8) indexes.delete(indexes.keys().next().value!);
  }
  let partial = false;
  const seen = new Set<string>();
  for (const entry of existsSync(root) ? readdirSync(root, { withFileTypes: true }) : []) {
    if (!entry.isDirectory() || !/^[\da-f-]{36}$/.test(entry.name)) continue;
    const dir = join(root, entry.name);
    // CLI and earlier versions write the same records. Include the WAL and the legacy JSON export.
    seen.add(entry.name);
    let stamp: string;
    let row: WorkflowSummary | undefined;
    try {
      stamp = workflowFileStamp(dir);
      if (index.records.get(entry.name)?.stamp === stamp) continue;
      row = readSummary(dir);
    } catch (error) {
      const e = error as { code?: string; errcode?: number };
      if (
        !(
          error instanceof SyntaxError ||
          ['ENOENT', 'EACCES', 'EPERM', 'EBUSY'].includes(e.code ?? '') ||
          [1, 5, 6, 11, 26].includes((e.errcode ?? 0) & 255)
        )
      )
        throw error;
      // Never serve a stale row or memoize a failure across lock release.
      partial = true;
      if (index.records.delete(entry.name)) index.pages.clear();
      continue;
    }
    index.records.set(entry.name, {
      stamp,
      row:
        row?.id === entry.name &&
        typeof row.cwd === 'string' &&
        row.cwd &&
        typeof row.updatedAt === 'string'
          ? row
          : undefined,
    });
    index.pages.clear();
    index.paths.clear();
  }
  for (const key of index.records.keys())
    if (!seen.has(key)) {
      index.records.delete(key);
      index.pages.clear();
    }
  for (const [path, key] of index.paths)
    if (projectDirectoryKey(path) !== key) {
      index.pages.clear();
      index.paths.clear();
      break;
    }
  return { index, partial };
}
export function listWorkflowPage(root: string, cwd: string, options: HistoryPageOptions = {}) {
  const { session, offset = 0, limit = 25 } = options;
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error('无效的流程历史分页参数');
  const { index, partial } = refreshIndex(root);
  const project = projectDirectoryKey(cwd);
  const scope = JSON.stringify([project, session]);
  let items = index.pages.get(scope);
  if (!items) {
    items = [];
    const paths = index.paths;
    for (const { row } of index.records.values()) {
      if (!row || (session && row.session !== session)) continue;
      if (!paths.has(row.cwd)) paths.set(row.cwd, projectDirectoryKey(row.cwd));
      if (paths.get(row.cwd) === project) items.push(row);
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    if (index.pages.size >= 64) index.pages.delete(index.pages.keys().next().value!);
    index.pages.set(scope, items);
  }
  const end = offset + limit;
  return {
    items: items.slice(offset, end).map((item) => ({ ...item })),
    total: items.length,
    ...(partial && { partial: true }),
    nextOffset: end < items.length ? end : null,
  };
}
