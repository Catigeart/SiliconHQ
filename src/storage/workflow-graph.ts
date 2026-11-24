import { z } from 'zod';
import { canReturnToDeveloper } from '../workflow/rules.js';
const workflowGraphSchema = z.object({
  version: z.literal(1).optional(),
  cursor: z.int().nonnegative(),
  counts: z.record(z.string(), z.int().nonnegative()),
  batch: z.array(z.string()).min(1).optional(),
  feedback: z
    .object({
      target: z.string(),
      report: z.record(z.string(), z.unknown()),
      pendingReview: z.string().optional(),
      sourceRunId: z.string().optional(),
    })
    .optional(),
  recheck: z.array(z.string()).optional(),
  humanReturn: z
    .object({
      gate: z.string(),
      approvalId: z.string(),
      target: z.string(),
      previousRun: z.string(),
      note: z.string(),
    })
    .optional(),
});
/** Validate the active snapshot before a recovery can write a new checkpoint. */
export function restoreGraph(
  flow: import('./workflows.js').Workflow,
  steps: { id: string; parallelGroup?: string; kind: string; returnTo?: string }[],
): WorkflowGraph {
  if (!flow.graph && !flow.steps.length && !flow.pendingApproval)
    return { version: 1 as const, cursor: 0, counts: {} };
  const parsed = workflowGraphSchema.safeParse(flow.graph);
  const invalid = (reason: string): never => {
    throw new Error('流程执行快照无法恢复，原记录已保留：' + reason);
  };
  if (!parsed.success)
    return invalid(parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('；'));
  const g = parsed.data;
  const nodes = new Map(steps.map((s) => [s.id, s]));
  if (
    g.cursor > steps.length ||
    (g.cursor === steps.length &&
      ['running', 'waiting_approval', 'failed', 'cancelled', 'blocked'].includes(flow.status))
  )
    return invalid('cursor');
  const finished = new Set(
    flow.steps
      .filter(
        (s) =>
          !s.supersededByApproval &&
          !s.supersededByRepair &&
          ['completed', 'skipped'].includes(s.status),
      )
      .map((s) => s.node),
  );
  if (steps.slice(0, g.cursor).some((node) => !finished.has(node.id)))
    return invalid('cursor 跳过未完成步骤');
  const current = steps[g.cursor];
  if (current?.parallelGroup && steps[g.cursor - 1]?.parallelGroup === current.parallelGroup)
    return invalid('并行组游标');
  if (
    Object.keys(g.counts).some((id) => !canReturnToDeveloper(nodes.get(id)?.kind ?? '')) ||
    (g.feedback &&
      (nodes.get(g.feedback.target)?.kind !== 'develop' ||
        g.feedback.target !== current?.id ||
        (g.feedback.pendingReview &&
          nodes.get(g.feedback.pendingReview)?.returnTo !== g.feedback.target)))
  )
    return invalid('修复目标');
  // Sequential checkpoints predating batches used the last unfinished step as their receipt.
  if (!g.version && !g.batch && current && !current.parallelGroup) {
    const last = flow.steps.at(-1);
    if (
      last &&
      last.node === current.id &&
      !last.supersededByApproval &&
      !last.supersededByRepair
    ) {
      if (['failed', 'running', 'cancelled'].includes(last.status)) g.batch = [last.runId];
      else if (flow.status === 'blocked' && last.verdict === 'blocked') {
        g.batch = [last.runId];
        g.recheck = [current.id];
      }
    }
  }
  if (['failed', 'blocked'].includes(flow.status) && !g.batch) return invalid('缺少待恢复批次');
  if (g.batch) {
    let end = g.cursor + 1;
    while (current?.parallelGroup && steps[end]?.parallelGroup === current.parallelGroup) end++;
    if (
      !current ||
      g.batch.length !== end - g.cursor ||
      new Set(g.batch).size !== g.batch.length ||
      g.batch.some(
        (id, i) =>
          !flow.steps.some(
            (s) =>
              s.runId === id &&
              !s.supersededByApproval &&
              !s.supersededByRepair &&
              s.node === steps[g.cursor + i]?.id,
          ),
      )
    )
      return invalid('并行执行记录');
  }
  if (
    g.recheck?.some(
      (id) => !g.batch?.some((run) => flow.steps.some((s) => s.runId === run && s.node === id)),
    )
  )
    return invalid('复核目标');
  if (
    g.humanReturn &&
    (nodes.get(g.humanReturn.gate)?.kind !== 'approval' ||
      !nodes.has(g.humanReturn.target) ||
      !flow.steps.some(
        (s) => s.runId === g.humanReturn!.previousRun && s.node === g.humanReturn!.target,
      ))
  )
    return invalid('人工退回记录');
  if (
    flow.status === 'waiting_approval' &&
    (!flow.pendingApproval ||
      flow.pendingApproval.node !== current?.id ||
      current?.kind !== 'approval' ||
      !flow.pendingApproval.id ||
      g.batch)
  )
    return invalid('待确认步骤');
  if (flow.pendingApproval && flow.status !== 'waiting_approval') return invalid('待确认状态');
  return { ...g, version: 1 as const };
}
export type WorkflowGraph = z.infer<typeof workflowGraphSchema>;
