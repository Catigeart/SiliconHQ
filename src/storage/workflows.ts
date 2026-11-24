import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Speed } from '../config/speed.js';
import { dataDirectory, lockFile, recordDirectory } from './files.js';
import { type Run } from './runs.js';
import { Journal } from '../runtime/journal.js';
import {
  indexWorkflowSummary,
  listWorkflowPage,
  type HistoryPageOptions,
} from './workflow-history.js';
import { archiveMissingRounds, loadArchivedRounds } from './workflow-archive.js';
import { workflowRecordSchema } from './schemas.js';
import {
  readProgress,
  readProgressHead,
  readStep,
  roundSummary,
  writeProgress,
} from './workflow-progress.js';

export type WorkflowStep = {
  node?: string;
  pendingRepairCharge?: boolean;
  report?: Record<string, unknown>;
  error?: string;
  waitingForCapacity?: boolean;
  verificationStartedAt?: string;
  supersededByApproval?: string;
  supersededByRepair?: string;
  stoppingJobId?: string;
  provider?: string;
  routeOverride?: DshRoute;
  previousAttempts?: {
    executionId: string;
    route: DshRoute;
    status: Run['status'];
    error?: string;
    startedAt: string;
    finishedAt?: string;
  }[];
  stage: Workflow['stage'];
  runId: string;
  status: Run['status'];
  verdict?: Run['reviewVerdict'];
  outcome?: Run['implementationOutcome'];
  sourceReviewId?: string;
  startedAt: string;
  finishedAt?: string;
  prompt?: string;
  executionId?: string;
  resumeCount?: number;
  skipReason?: string;
};
export type WorkflowRound = Omit<Workflow, 'rounds'>;
export type DshRoute = {
  backend: string;
  product?: 'codex' | 'claude-code';
  provider?: string;
  model?: string;
  reasoningEffort?: string;
  agentPreset?: string;
  baseBackend?: string;
  instanceName?: string;
  instanceId?: string;
};
type Template = import('../workflow/templates.js').WorkflowTemplate;
type FrozenTemplate = Omit<Template, 'steps'> & { steps: (Template['steps'][number] & DshRoute)[] };
type RoleRoutes = Record<'planner' | 'developer' | 'reviewer', DshRoute> & { feedback?: DshRoute };
export type DshRouting = {
  reviewPolicy?: import('../roles/reviewer.js').ReviewPolicy;
  handoff?: {
    id: string;
    kind: 'chat' | 'report' | 'diff' | 'document';
    label: string;
    text: string;
  }[];
  session: string;
} & ({ roles: RoleRoutes; template?: never } | { template: FrozenTemplate; roles?: never });
export type Workflow = {
  dsh?: DshRouting;
  graph?: import('./workflow-graph.js').WorkflowGraph;
  speedOverride?: Speed;
  round?: number;
  rounds?: WorkflowRound[];
  archivedRounds?: number; // Count retained by readCurrent without materializing immutable rounds.
  previousRoleRunIds?: Partial<Record<'planner' | 'developer' | 'reviewer', string>>;
  id: string;
  prompt: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status:
    | 'running'
    | 'completed'
    | 'passed'
    | 'changes_requested'
    | 'incomplete'
    | 'blocked'
    | 'failed'
    | 'cancelled'
    | 'repair_limit_reached'
    | 'waiting_approval'
    | 'rejected';
  stage:
    | 'approval'
    | 'verify'
    | 'read'
    | 'plan'
    | 'implement'
    | 'review'
    | 'repair'
    | 'developer_feedback'
    | 'planner_summary';
  pendingApproval?: {
    id: string;
    node: string;
    name: string;
    instructions: string;
    inputs: string[];
    targetsVersion?: number;
    returnTargets?: { id: string; name: string }[];
  };
  maxRepairs: number;
  repairCount: number;
  stopReason?: string;
  steps: WorkflowStep[];
  resumeCount?: number;
  resumedAt?: string;
  planRunId?: string;
  implementationRunId?: string;
  latestReviewRunId?: string;
  developerFeedbackRunId?: string;
  finalSummaryRunId?: string;
  summaryFile?: string;
  failureReason?: 'repair_budget_exhausted';
  error?: string;
};
export class WorkflowStore {
  constructor(readonly root = dataDirectory('workflows')) {}
  directory(id: string): string {
    return recordDirectory(this.root, id);
  }
  create(prompt: string, cwd: string, maxRepairs = 2, dsh?: DshRouting): Workflow {
    const flow: Workflow = {
      id: randomUUID(),
      ...(dsh && { dsh }),
      prompt,
      cwd,
      createdAt: new Date().toISOString(),
      updatedAt: '',
      status: 'running',
      stage: 'plan',
      steps: [],
      maxRepairs,
      repairCount: 0,
    };
    this.save(flow);
    return flow;
  }
  artifactDirectory(flow: Workflow): string {
    const dir =
      (flow.round ?? 1) === 1
        ? this.directory(flow.id)
        : join(this.directory(flow.id), `round-${flow.round}`);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }
  save(flow: Workflow): void {
    const dir = this.directory(flow.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    flow.updatedAt = new Date().toISOString();
    const { rounds = [], archivedRounds: prior = 0, ...current } = flow;
    const archivedRounds = flow.dsh ? prior + rounds.length : 0;
    const checkpoint = archivedRounds ? { ...current, archivedRounds } : flow;
    const journal = new Journal(dir);
    journal.checkpoint('workflow.json', checkpoint, undefined, (db) => {
      indexWorkflowSummary(db);
      const indexed = db.prepare('PRAGMA user_version').get()?.user_version === 2;
      if (prior && !indexed) {
        // A JSON-only restore has the compact head and immutable exports but no SQL archive yet.
        const restored = loadArchivedRounds(journal, flow.id, prior);
        archiveMissingRounds(db, flow.id, [...restored, ...rounds], roundSummary);
      } else if (archivedRounds || indexed) {
        archiveMissingRounds(db, flow.id, rounds, roundSummary, prior);
      }
      writeProgress(db, archivedRounds ? current : flow, archivedRounds);
    });
  }
  readProgressHead(id: string) {
    return readProgressHead(new Journal(this.directory(id)), id);
  }
  readProgress(id: string, requested?: number, headings = false) {
    return readProgress(
      new Journal(this.directory(id)),
      id,
      () => this.read(id),
      requested,
      headings,
    );
  }
  readStep(id: string, round: number, index: number) {
    return readStep(new Journal(this.directory(id)), id, round, index, () => this.read(id));
  }
  read(id: string): Workflow {
    const flow = this.readCurrent(id);
    if (flow.archivedRounds) {
      flow.rounds = loadArchivedRounds(new Journal(this.directory(id)), id, flow.archivedRounds);
      delete flow.archivedRounds;
    }
    return flow;
  }
  readCurrent(id: string): Workflow {
    const journal = new Journal(this.directory(id));
    const flow = workflowRecordSchema.parse(journal.readCheckpoint('workflow.json')) as Workflow;
    if (
      flow.id !== id ||
      typeof flow.prompt !== 'string' ||
      typeof flow.cwd !== 'string' ||
      !Array.isArray(flow.steps)
    )
      throw new Error('流程记录损坏');
    // 兼容有限修复循环上线前创建的串行流程；不额外赠送修复预算。
    flow.round ??= 1;
    flow.rounds ??= [];
    flow.maxRepairs ??= 0;
    flow.repairCount ??= 0;
    if (
      !Number.isInteger(flow.maxRepairs) ||
      flow.maxRepairs < 0 ||
      flow.maxRepairs > 2 ||
      !Number.isInteger(flow.repairCount) ||
      flow.repairCount < 0 ||
      flow.repairCount > flow.maxRepairs
    )
      throw new Error('流程修复预算损坏');
    return flow;
  }
  lock(id: string): () => void {
    return lockFile(join(this.directory(id), 'lock'));
  }
  listPage(cwd: string, options?: HistoryPageOptions) {
    return listWorkflowPage(this.root, cwd, options);
  }
  list(): Workflow[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((id) => /^[a-f0-9-]{36}$/.test(id))
      .map((id) => this.read(id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
