import { reassignmentOptions } from './workflow-reassignment.js';
import { describeRun, runApprovalContext, runProgress, runStep } from './run-results.js';
import { scopedFlow, sessionWorkspace } from './dsh-workspace.js';
import { WorkflowStore } from './dist/storage/workflows.js';
import { RunStore } from './dist/storage/runs.js';
import { runProgressQuery } from './dist/storage/workflow-progress.js';
import { hasActiveWorkflowJob } from './native.js';

export function historyPage(store, cwd, sessionId, offset = 0, limit = 25) {
  if (typeof sessionId !== 'string' || !sessionId) throw new Error('请打开目标 DSH 会话后查询。');
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error('历史分页参数无效');
  return store.listPage(cwd, { session: sessionId, offset, limit });
}

export function registerRunQueries(ctx, config, endpoint) {
  endpoint('runHistory', ({ sessionId, offset, limit }) =>
    historyPage(new WorkflowStore(), sessionWorkspace(ctx, sessionId), sessionId, offset, limit),
  );
  endpoint('runDetail', ({ sessionId, id, round }) => {
    const store = new WorkflowStore();
    const flow = scopedFlow(ctx, sessionId, id, store, false);
    return describeRun(flow, new RunStore(), round, { store, active: hasActiveWorkflowJob(id) });
  });
  endpoint('runProgress', (payload, signal) => {
    signal.throwIfAborted();
    const query = runProgressQuery.safeParse(payload);
    if (!query.success) throw new Error('运行进度查询参数无效，请重新打开运行详情。');
    return runProgress(ctx, query.data, new WorkflowStore(), hasActiveWorkflowJob(query.data.id));
  });
  endpoint('runStep', (payload) => runStep(ctx, payload, new WorkflowStore(), new RunStore()));
  endpoint('reassignmentOptions', ({ sessionId, id, executionId }) =>
    reassignmentOptions(
      ctx,
      config,
      scopedFlow(ctx, sessionId, id, new WorkflowStore()),
      executionId,
    ),
  );
  endpoint('runApprovalContext', (payload) =>
    runApprovalContext(ctx, payload, new WorkflowStore()),
  );
}
