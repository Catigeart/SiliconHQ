import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { RunStore, type Run } from '../storage/runs.js';
import { WorkflowStore, type Workflow } from '../storage/workflows.js';
import { failureContextSchema, summaryContextSchema, developerFeedbackSchema, finalSummarySchema, renderFinalSummary } from '../roles/closeout.js';
import { validateReview } from '../roles/reviewer.js';
import { getRoleDefinition } from '../roles/index.js';
import type { RunPurpose } from '../roles/types.js';

const readJson = (store: RunStore, id: string, file: string) => JSON.parse(readFileSync(join(store.directory(id), file), 'utf8'));

function createCloseout(store: RunStore, source: Run, purpose: RunPurpose, snapshot: unknown): Run {
  const run = store.create(source.prompt, source.cwd);
  Object.assign(run, {
    role: source.role, purpose, sourceRunId: source.id,
    speed: source.speed ?? 'inherit', model: source.model, reasoningEffort: source.reasoningEffort, threadId: source.threadId,
    sourcePlanId: source.sourcePlanId, sourceImplementationId: source.sourceImplementationId,
  });
  try {
    const definition = getRoleDefinition(run.role!, purpose);
    writeFileSync(join(store.directory(run.id), definition.snapshotFile!), JSON.stringify(snapshot, null, 2), { mode: 0o600 });
    store.save(run);
  } catch (error) { run.status = 'failed'; run.error = String(error); store.save(run); throw error; }
  return run;
}

export function prepareDeveloperFeedback(store: RunStore, flow: Workflow): Run {
  if (!flow.implementationRunId || !flow.latestReviewRunId) throw new Error('收尾缺少实现或检查任务');
  const developer = store.read(flow.implementationRunId);
  const review = store.read(flow.latestReviewRunId);
  if (developer.role !== 'developer' || developer.status !== 'completed' || review.status !== 'completed') throw new Error('收尾来源任务尚未完成');
  const snapshot = {
    workflowId: flow.id, originalRequirement: flow.prompt,
    planSnapshot: readJson(store, developer.id, 'plan-snapshot.json'),
    implementation: readJson(store, developer.id, 'implementation.json'),
    finalReviewRunId: review.id,
    finalReview: validateReview(readFileSync(join(store.directory(review.id), 'review.json'), 'utf8'), readJson(store, review.id, 'review-snapshot.json')),
    repairCount: flow.repairCount, maxRepairs: flow.maxRepairs,
    reviewHistory: flow.steps.filter(step => step.stage === 'review' && step.status === 'completed').map(step => ({ runId: step.runId, report: readJson(store, step.runId, 'review.json') })),
  };
  failureContextSchema.parse(snapshot);
  if (snapshot.finalReview.verdict !== 'changes_requested') throw new Error('失败收尾需要未通过的最终检查');
  return createCloseout(store, developer, 'developer_feedback', snapshot);
}

export function preparePlannerSummary(store: RunStore, flow: Workflow): Run {
  if (!flow.planRunId || !flow.developerFeedbackRunId) throw new Error('收尾缺少 planner 或 developer 反馈任务');
  const planner = store.read(flow.planRunId);
  const feedback = store.read(flow.developerFeedbackRunId);
  if (planner.role !== 'planner' || feedback.status !== 'completed' || feedback.purpose !== 'developer_feedback') throw new Error('developer 反馈尚未完成');
  const snapshot = {
    ...readJson(store, feedback.id, 'failure-context.json'),
    developerFeedbackRunId: feedback.id,
    developerFeedback: developerFeedbackSchema.parse(readJson(store, feedback.id, 'developer-feedback.json')),
  };
  summaryContextSchema.parse(snapshot);
  return createCloseout(store, planner, 'planner_summary', snapshot);
}

export function publishFinalSummary(store: RunStore, flows: WorkflowStore, flow: Workflow, run: Run, display = true): void {
  const report = finalSummarySchema.parse(readJson(store, run.id, 'final-summary.json'));
  const text = renderFinalSummary(report);
  for (const [name, content] of [['summary.json', JSON.stringify(report, null, 2)], ['summary.txt', text]]) {
    const path = join(flows.artifactDirectory(flow), name!);
    writeFileSync(path + '.tmp', content!, { mode: 0o600 });
    renameSync(path + '.tmp', path);
  }
  flow.summaryFile = (flow.round ?? 1) === 1 ? 'summary.txt' : `round-${flow.round}/summary.txt`;
  if (display) {
    console.log(text);
    console.error(`[最终说明] ${join(flows.directory(flow.id), flow.summaryFile)}`);
  }
}
