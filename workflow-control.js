import { assertRoundAction } from './dist/workflow/rules.js';
import { gateActions } from './approval-return.js';
import { createHash } from 'node:crypto';

export function currentBatch(flow) {
  const batch = flow.dsh?.template && flow.graph?.batch;
  return batch ? flow.steps.filter((step) => batch.includes(step.runId)) : flow.steps.slice(-1);
}

export function recoveryView(flow, nameOf = (step) => step.node ?? step.stage) {
  const entries = currentBatch(flow);
  const targets = entries.filter((step) => !['completed', 'skipped'].includes(step.status));
  const token = createHash('sha256')
    .update(
      JSON.stringify([
        flow.id,
        flow.round ?? 1,
        flow.updatedAt,
        flow.status,
        flow.stage,
        entries.map((step) => [step.runId, step.executionId, step.status]),
      ]),
    )
    .digest('hex');
  return {
    token,
    targets: targets.map((step) => step.runId),
    attempts: targets.map((step) => ({ executionId: step.executionId, name: nameOf(step) })),
  };
}

// Called both at submission and under the flow lock before any new side effect.
export function assertWorkflowCommand(flow, request) {
  if (request.expectedState !== undefined && request.expectedState !== recoveryView(flow).token)
    throw new Error('流程或执行尝试已变更，请刷新运行详情后再操作。');
  if (gateActions.includes(request.action)) {
    if (flow.status !== 'waiting_approval')
      throw new Error('此确认已失效，审批已处理或流程已结束，请刷新运行详情。');
    if (!request.approvalId || flow.pendingApproval?.id !== request.approvalId)
      throw new Error('此确认已失效，请刷新运行详情。');
  } else if (flow.status === 'waiting_approval') {
    throw new Error('当前流程等待人工确认，请在运行详情处理。');
  }
  if (request.expectedRound !== undefined && request.expectedRound !== (flow.round ?? 1))
    throw new Error('轮次已更新，请重新预览');
  assertRoundAction(request.action, flow.status, !!flow.dsh?.template);
}
