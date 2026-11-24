import type { DatabaseSync } from 'node:sqlite';
import type { Journal } from '../runtime/journal.js';
import type { WorkflowRound } from './workflows.js';

export const archiveName = (round: number) => 'round-' + round + '.json';

// Called in the same transaction as the new current round. Completed rounds are immutable.
export function archiveMissingRounds(
  db: DatabaseSync,
  id: string,
  rounds: WorkflowRound[],
  summarize: (round: WorkflowRound) => unknown,
  prior = 0,
): void {
  db.exec(
    'CREATE TABLE IF NOT EXISTS workflow_archive (round INTEGER PRIMARY KEY, summary TEXT NOT NULL)',
  );
  const last = Number(
    db.prepare('SELECT coalesce(max(round), 0) AS n FROM workflow_archive').get()?.n,
  );
  const count = prior + rounds.length;
  if (last < prior || last > count) throw new Error('流程归档轮次已变化，请重新读取记录');
  if (last === count) return;
  db.exec('PRAGMA user_version=2');
  const save = db.prepare('INSERT INTO checkpoints (name,value) VALUES (?,?)');
  const index = db.prepare('INSERT INTO workflow_archive (round,summary) VALUES (?,?)');
  const publish = db.prepare('INSERT OR IGNORE INTO pending_exports VALUES (?)');
  for (let i = last; i < count; i++) {
    const snapshot = rounds[i - prior]!;
    if (snapshot.id !== id || (snapshot.round ?? i + 1) !== i + 1)
      throw new Error('流程归档与轮次不匹配');
    const name = archiveName(i + 1);
    save.run(name, JSON.stringify(snapshot));
    index.run(i + 1, JSON.stringify(summarize(snapshot)));
    publish.run(name);
  }
}

export function loadArchivedRounds(journal: Journal, id: string, count: number): WorkflowRound[] {
  const rows = journal.queryCheckpoint((db) => {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='workflow_archive'").get()) return;
    return db
      .prepare(
        `SELECT c.value FROM workflow_archive a
      JOIN checkpoints c ON c.name = 'round-' || a.round || '.json'
      WHERE a.round <= ? ORDER BY a.round`,
      )
      .all(count);
  });
  if (rows && rows.length !== count) throw new Error('流程归档不完整');
  return Array.from({ length: count }, (_, i) => {
    const snapshot = (
      rows ? JSON.parse(String(rows[i]!.value)) : journal.readCheckpoint(archiveName(i + 1))
    ) as WorkflowRound;
    if (snapshot.id !== id || (snapshot.round ?? i + 1) !== i + 1 || !Array.isArray(snapshot.steps))
      throw new Error('流程归档与轮次不匹配');
    return snapshot;
  });
}
