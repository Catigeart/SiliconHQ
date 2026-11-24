import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { canResumeRound } from '../workflow/rules.js';
import { archiveName } from './workflow-archive.js';
import type { DatabaseSync } from 'node:sqlite';
import type { Journal } from '../runtime/journal.js';
import type { DshRoute, Workflow, WorkflowRound, WorkflowStep } from './workflows.js';

export const runProgressQuery = z.object({
  sessionId: z.string().min(1),
  id: z.string().min(1),
  round: z.int().positive().optional(),
  revision: z.string().optional(),
});
export type RunProgressQuery = z.infer<typeof runProgressQuery>;

export function routeSummary(route: DshRoute) {
  const {
    backend,
    baseBackend,
    provider,
    model,
    reasoningEffort,
    instanceName,
    instanceId,
    agentPreset,
  } = route;
  return {
    backend,
    baseBackend,
    provider,
    model,
    reasoningEffort,
    instanceName,
    instanceId,
    agentPreset,
  };
}

export function roundSummary(view: WorkflowRound) {
  const {
    id,
    cwd,
    round,
    createdAt,
    updatedAt,
    status,
    stage,
    stopReason,
    repairCount,
    maxRepairs,
  } = view;
  const routes = view.dsh;
  return {
    id,
    cwd,
    round,
    createdAt,
    updatedAt,
    status,
    stage,
    stopReason,
    repairCount,
    maxRepairs,
    prompt: view.prompt?.slice(0, 500),
    error: view.error?.slice(0, 1000),
    pendingApproval: view.pendingApproval,
    graph: view.graph?.batch ? { batch: view.graph.batch } : undefined,
    dsh: routes && {
      session: routes.session,
      roles:
        routes.roles &&
        Object.fromEntries(
          Object.entries(routes.roles).map(([name, route]) => [name, routeSummary(route)]),
        ),
      template: routes.template && {
        id: routes.template.id,
        name: routes.template.name,
        steps: (routes.template.steps ?? []).map(({ id, name, kind, ...route }) => ({
          id,
          name,
          kind,
          ...routeSummary(route),
        })),
      },
    },
    steps: (view.steps ?? []).map((step) => {
      const {
        node,
        stage,
        runId,
        executionId,
        provider,
        status,
        startedAt,
        finishedAt,
        verdict,
        outcome,
        skipReason,
        supersededByApproval,
        supersededByRepair,
        stoppingJobId,
        waitingForCapacity,
      } = step;
      const text = step.report?.summary ?? step.report?.goal;
      return {
        node,
        stage,
        runId,
        executionId,
        provider,
        routeOverride: step.routeOverride,
        status,
        startedAt,
        finishedAt,
        verdict,
        outcome,
        skipReason,
        supersededByApproval,
        supersededByRepair,
        stoppingJobId,
        waitingForCapacity,
        error: step.error?.slice(0, 1000),
        ...(Array.isArray(step.report?.suggestions) && {
          suggestionCount: step.report.suggestions.length,
          blockingCount: Array.isArray(step.report.findings) ? step.report.findings.length : 0,
        }),
        reportSummary: typeof text === 'string' ? text.slice(0, 240) : undefined,
        ...(stage === 'verify' &&
          step.report &&
          (typeof step.report.exitCode === 'number' || step.report.exitCode === null) && {
            exitCode: step.report.exitCode,
          }),
        // Built-in stages save a role artifact instead of an inline report.
        reportAvailable: !!step.report || (!routes?.template && status === 'completed'),
      };
    }),
  };
}

function summarize(flow: Workflow) {
  return { ...roundSummary(flow), rounds: (flow.rounds ?? []).map(roundSummary) };
}

type RoundHeading = { round: number; prompt: string; status: string };
type Progress = {
  format?: 2;
  revision: string;
  flow: ReturnType<typeof summarize>;
  headings?: RoundHeading[];
};

// Check the checkpoint identity before materializing any step summaries.
export function readProgressHead(journal: Journal, id: string) {
  return journal.queryCheckpoint((db) => {
    const row = db
      .prepare(
        `SELECT json_extract(value,'$.revision') AS revision,
      json_extract(value,'$.flow.id') AS id, json_extract(value,'$.flow.cwd') AS cwd,
      json_type(value,'$.flow.dsh') AS routing, json_extract(value,'$.flow.dsh.session') AS session, json_extract(value,'$.flow.status') AS status,
      coalesce(json_extract(value,'$.flow.round'),1) AS round FROM checkpoints WHERE name='progress-v1'`,
      )
      .get();
    if (!row) return;
    if (row.id !== id || typeof row.revision !== 'string') throw new Error('流程进度记录损坏');
    return {
      id,
      revision: row.revision,
      cwd: String(row.cwd),
      dsh: row.routing === 'object' ? { session: row.session } : undefined,
      status: String(row.status),
      round: Number(row.round),
    };
  });
}

export function writeProgress(db: DatabaseSync, flow: Workflow, archivedRounds = 0): void {
  // Older writers also replace workflow.json. Invalidate the derived row on any
  // write, then repopulate it within the same transaction for current writers.
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS progress_v1_insert AFTER INSERT ON checkpoints
    WHEN NEW.name='workflow.json' BEGIN DELETE FROM checkpoints WHERE name='progress-v1'; END;
    CREATE TRIGGER IF NOT EXISTS progress_v1_update AFTER UPDATE ON checkpoints
    WHEN NEW.name='workflow.json' OR OLD.name='workflow.json' BEGIN DELETE FROM checkpoints WHERE name='progress-v1'; END;
    CREATE TRIGGER IF NOT EXISTS progress_v1_delete AFTER DELETE ON checkpoints
    WHEN OLD.name='workflow.json' BEGIN DELETE FROM checkpoints WHERE name='progress-v1'; END;
  `);
  const snapshot: Progress = {
    format: 2,
    revision: randomUUID(),
    flow: summarize(flow),
    ...(archivedRounds && { archivedRounds }),
  };
  db.prepare("INSERT OR REPLACE INTO checkpoints VALUES ('progress-v1', ?)").run(
    JSON.stringify(snapshot),
  );
}

export function readProgress(
  journal: Journal,
  id: string,
  legacy: () => Workflow,
  requested?: number,
  headings = false,
): Progress {
  const row = journal.queryCheckpoint((db) => {
    const row = db.prepare("SELECT value FROM checkpoints WHERE name='progress-v1'").get();
    if (!row) return;
    const saved = JSON.parse(String(row.value)) as Progress & { archivedRounds?: number };
    // Old summaries omitted the batch. Both rows must come from this one WAL snapshot.
    if (
      !saved.format &&
      saved.flow.dsh?.template &&
      !saved.flow.graph &&
      canResumeRound(saved.flow.status)
    ) {
      const current = db
        .prepare(
          "SELECT json_extract(value, '$.graph.batch') AS batch FROM checkpoints WHERE name='workflow.json'",
        )
        .get();
      if (!current) throw new Error('缺少流程检查点，请重新读取记录');
      if (typeof current.batch === 'string')
        saved.flow.graph = { batch: JSON.parse(current.batch) };
    }
    if (saved.archivedRounds && requested !== undefined) {
      const round = requested || (saved.flow.round ?? 1);
      if (round !== (saved.flow.round ?? 1)) {
        if (round < 1 || round > saved.archivedRounds) throw new Error('找不到所选轮次');
        const archive = db.prepare('SELECT summary FROM workflow_archive WHERE round=?').get(round);
        if (!archive) throw new Error('流程归档不完整');
        saved.flow.rounds = [{ ...JSON.parse(String(archive.summary)), round }];
      }
      if (headings) {
        const rows = db
          .prepare(
            `SELECT round,json_extract(summary,'$.prompt') AS prompt,json_extract(summary,'$.status') AS status FROM workflow_archive WHERE round<=? ORDER BY round`,
          )
          .all(saved.archivedRounds);
        if (rows.length !== saved.archivedRounds) throw new Error('流程归档不完整');
        saved.headings = rows.map((r) => ({
          round: Number(r.round),
          prompt: String(r.prompt),
          status: String(r.status),
        }));
        saved.headings.push({
          round: saved.flow.round ?? 1,
          prompt: saved.flow.prompt,
          status: saved.flow.status,
        });
      }
    } else if (saved.archivedRounds) {
      const rows = db
        .prepare('SELECT summary FROM workflow_archive WHERE round <= ? ORDER BY round')
        .all(saved.archivedRounds);
      if (rows.length !== saved.archivedRounds) throw new Error('流程归档不完整');
      saved.flow.rounds = rows.map((r) => JSON.parse(String(r.summary)));
    }
    return saved;
  });
  if (row) {
    if (row.flow.id !== id || !row.revision) throw new Error('流程进度记录损坏');
    return row;
  }
  const flow = summarize(legacy());
  return { flow, revision: createHash('sha256').update(JSON.stringify(flow)).digest('hex') };
}

export function readStep(
  journal: Journal,
  id: string,
  round: number,
  index: number,
  legacy: () => Workflow,
): WorkflowStep {
  if (!Number.isSafeInteger(index) || index < 0 || !Number.isSafeInteger(round) || round < 1)
    throw new Error('无效的步骤或轮次');
  const path = '$.steps[' + index + ']';
  const row = journal.queryCheckpoint((db) =>
    db
      .prepare(
        `
    SELECT CASE WHEN coalesce(json_extract(value, '$.round'), 1) = ?
      THEN json_extract(value, ?)
      WHEN ? BETWEEN 1 AND json_extract(value, '$.archivedRounds')
        THEN (SELECT json_extract(a.value, ?) FROM checkpoints a WHERE a.name = ? AND json_extract(a.value, '$.id') = ?)
      ELSE (SELECT json_extract(r.value, ?) FROM json_each(w.value, '$.rounds') AS r
            WHERE coalesce(json_extract(r.value, '$.round'), r.key + 1) = ?)
    END AS entry, json_extract(value,'$.id') AS id
    FROM checkpoints AS w WHERE name='workflow.json'
  `,
      )
      .get(round, path, round, path, archiveName(round), id, path, round),
  );
  if (row) {
    if (row.id !== id || !row.entry) throw new Error('找不到所选轮次的步骤');
    return JSON.parse(String(row.entry)) as WorkflowStep;
  }
  const flow = legacy();
  const view =
    (flow.round ?? 1) === round ? flow : flow.rounds?.find((r, i) => (r.round ?? i + 1) === round);
  const entry = view?.steps?.[index] as WorkflowStep | undefined;
  if (!entry) throw new Error('找不到所选轮次的步骤');
  return entry;
}
