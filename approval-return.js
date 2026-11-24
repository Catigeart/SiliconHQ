export const gateActions = ['approve', 'reject', 'return'];

// Rewind within this approval segment. A parallel group must always start as a unit.
export function returnTargets(flow, gate) {
  const steps = flow.dsh?.template?.steps ?? [];
  const index = steps.findIndex((step) => step.id === gate.node);
  if (index < 0) return [];
  const latest = new Map();
  for (const entry of flow.steps)
    if (!entry.supersededByApproval && !entry.supersededByRepair) latest.set(entry.node, entry);
  const prior = steps.slice(0, index);
  const lastGate = prior.findLastIndex(
    (step) => step.kind === 'approval' && latest.get(step.id)?.status === 'completed',
  );
  return prior
    .slice(lastGate + 1)
    .filter(
      (step) =>
        ['read', 'plan', 'develop', 'review'].includes(step.kind) &&
        !step.parallelGroup &&
        latest.get(step.id)?.status === 'completed' &&
        (!step.when ||
          (latest.get(step.when.source)?.report?.verdict ??
            latest.get(step.when.source)?.report?.outcome) === step.when.equals),
    )
    .map(({ id, name }) => ({ id, name }));
}

export function checkGateReturn(flow, gate, request) {
  if (flow.repairCount >= flow.maxRepairs) throw new Error('本轮修复次数已用尽，不能再次退回。');
  if (typeof request.note !== 'string' || !request.note.trim())
    throw new Error('退回修改需要填写决定说明。');
  const target = returnTargets(flow, gate).find((item) => item.id === request.target);
  if (!target) throw new Error('请选择当前审批之前已完成的串行 Agent 步骤。');
  return target;
}

export function rewindApproval(flow, gate, target, note) {
  const steps = flow.dsh.template.steps;
  const start = steps.findIndex((step) => step.id === target.id);
  const ids = new Set(steps.slice(start, flow.graph.cursor).map((step) => step.id));
  const previous = flow.steps.findLast(
    (entry) => entry.node === target.id && !entry.supersededByApproval,
  );
  flow.graph.humanReturn = {
    gate: gate.node,
    approvalId: gate.id,
    target: target.id,
    previousRun: previous.runId,
    note,
  };
  for (const entry of flow.steps)
    if (ids.has(entry.node) && !entry.supersededByApproval) entry.supersededByApproval = gate.id;
  delete flow.graph.feedback;
  delete flow.graph.recheck;
  delete flow.graph.batch;
  flow.graph.cursor = start;
  flow.repairCount++;
}
