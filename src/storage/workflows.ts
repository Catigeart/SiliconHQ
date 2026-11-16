import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Speed } from '../config/speed.js';
import { atomicJson, dataDirectory, lockFile, recordDirectory } from './files.js';
import { type Run } from './runs.js';
import { Journal } from '../runtime/journal.js';
import { workflowRecordSchema } from './schemas.js';

export type WorkflowStep = {
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
};
export type WorkflowRound = Omit<Workflow, 'rounds'>;
export type Workflow = {
  speedOverride?: Speed;
  round?: number;
  rounds?: WorkflowRound[];
  previousRoleRunIds?: Partial<Record<'planner' | 'developer' | 'reviewer', string>>;
  id: string;
  prompt: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status:
    | 'running'
    | 'passed'
    | 'changes_requested'
    | 'blocked'
    | 'failed'
    | 'cancelled'
    | 'repair_limit_reached';
  stage: 'plan' | 'implement' | 'review' | 'repair' | 'developer_feedback' | 'planner_summary';
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
  create(prompt: string, cwd: string, maxRepairs = 2): Workflow {
    const flow: Workflow = {
      id: randomUUID(),
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
    const file = join(dir, 'workflow.json');
    new Journal(dir).checkpoint('workflow.json', flow);
  }
  read(id: string): Workflow {
    const flow = workflowRecordSchema.parse(
      new Journal(this.directory(id)).readCheckpoint('workflow.json'),
    ) as Workflow;
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
  list(): Workflow[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((id) => /^[a-f0-9-]{36}$/.test(id))
      .map((id) => this.read(id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
