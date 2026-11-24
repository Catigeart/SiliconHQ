import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { assertWorkflowCommand } from '../workflow-control.js';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runApprovalContext, runProgress, runStep } from '../run-results.js';
import { WorkflowStore } from '../dist/storage/workflows.js';
import { RunStore } from '../dist/storage/runs.js';

test('old progress snapshots recover the active failed parallel attempt without reloading unchanged views', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-old-reassign-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new WorkflowStore(join(root, 'flows'));
  const ctx = {
    get: (key) =>
      key === 'agents' ? { get: (id) => ({ id, session: { header: { cwd: root } } }) } : undefined,
  };
  const nodes = ['first', 'last'].map((id) => ({ id, kind: 'read', name: id, backend: 'spawn' }));
  const flow = store.create('Review', root, 0, {
    session: 's',
    template: { id: 'f', name: 'F', steps: nodes },
  });
  flow.status = 'failed';
  flow.steps = nodes.map((s, index) => ({
    node: s.id,
    stage: 'read',
    status: index ? 'completed' : 'failed',
    runId: randomUUID(),
    executionId: randomUUID(),
    startedAt: flow.createdAt,
  }));
  flow.graph = { cursor: 0, counts: {}, batch: flow.steps.map((s) => s.runId) };
  store.save(flow);
  const db = new DatabaseSync(join(store.directory(flow.id), 'runtime.sqlite'));
  try {
    db.exec(
      "UPDATE checkpoints SET value=json_remove(value,'$.flow.graph','$.format') WHERE name='progress-v1'",
    );
  } finally {
    db.close();
  }
  const query = { id: flow.id, sessionId: 's' };
  const detail = runProgress(ctx, query, store, false);
  store.readProgress = () => assert.fail('unchanged poll must not read step summaries');
  assert.deepEqual(detail.reassignable, [flow.steps[0].executionId]);
  store.read = () => {
    throw Error('should not load unchanged workflow');
  };
  assert.equal(
    runProgress(ctx, { ...query, revision: detail.revision }, store, false).unchanged,
    true,
  );
  // A writer commits after the read transaction and before the response is assembled.
  delete store.read;
  delete store.readProgress;
  const read = store.readProgress.bind(store);
  store.readProgress = (...args) => {
    const snapshot = read(...args);
    flow.steps[0].status = 'completed';
    flow.steps[1].status = 'failed';
    flow.steps[1].executionId = randomUUID();
    store.save(flow);
    return snapshot;
  };
  const stale = runProgress(ctx, query, store, false);
  assert.equal(stale.steps[0].status, 'failed');
  assert.throws(
    () => assertWorkflowCommand(flow, { action: 'retry', expectedState: stale.recovery.token }),
    /已变更/,
  );
});

test('older verification summaries recover the exit code only on a changed view', (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'sihq-old-exit-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const store = new WorkflowStore(join(cwd, 'flows'));
  const ctx = { get: () => ({ get: (id) => ({ id, session: { header: { cwd } } }) }) };
  const flow = store.create('Verify', cwd, 0, {
    session: 's',
    template: { id: 'v', name: 'V', steps: [{ id: 'v', name: 'Verify', kind: 'verify' }] },
  });
  flow.status = 'completed';
  flow.steps = [
    {
      stage: 'verify',
      node: 'v',
      runId: randomUUID(),
      executionId: randomUUID(),
      startedAt: flow.createdAt,
      status: 'completed',
      report: { exitCode: 0 },
    },
  ];
  store.save(flow);
  const compact = store.readProgress(flow.id);
  assert.equal(compact.flow.steps[0].exitCode, 0);
  delete compact.flow.steps[0].exitCode;
  store.readProgress = () => compact;
  const query = { id: flow.id, sessionId: 's' };
  const detail = runProgress(ctx, query, store, false);
  assert.equal(detail.steps[0].exitCode, 0);
  store.readStep = () => assert.fail('unchanged polling must not reload a command report');
  assert.equal(
    runProgress(ctx, { ...query, revision: detail.revision }, store, false).unchanged,
    true,
  );
});

test('v0.8 pending approvals use full metadata to offer eligible returns only once per revision', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-legacy-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const store = new WorkflowStore(join(root, 'flows'));
  const ctx = {
    get: (key) =>
      key === 'agents' ? { get: (id) => ({ id, session: { header: { cwd: root } } }) } : undefined,
  };
  const nodes = [
    { id: 'one', name: 'One', kind: 'read', parallelGroup: 'pair' },
    { id: 'two', name: 'Two', kind: 'read', parallelGroup: 'pair' },
    { id: 'summary', name: 'Summary', kind: 'read' },
    { id: 'gate', name: 'Gate', kind: 'approval' },
  ];
  const flow = store.create('Task', root, 1, {
    session: 's',
    template: { id: 'f', name: 'Flow', steps: nodes },
  });
  flow.status = 'waiting_approval';
  flow.pendingApproval = { id: 'old-token', node: 'gate', inputs: ['summary'] };
  flow.steps = nodes.slice(0, -1).map((node) => ({
    node: node.id,
    stage: 'read',
    status: 'completed',
    runId: randomUUID(),
    startedAt: flow.createdAt,
  }));
  store.save(flow);
  const query = { id: flow.id, sessionId: 's' };
  const detail = runProgress(ctx, query, store, false);
  assert.deepEqual(detail.pendingApproval.returnTargets, [{ id: 'summary', name: 'Summary' }]);
  store.read = () => {
    throw new Error('unchanged polling must not load a full run');
  };
  assert.equal(
    runProgress(ctx, { ...query, revision: detail.revision }, store, false).unchanged,
    true,
  );
});

test('an open gate can read the full current task and its selected sources on demand', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-approval-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let cwd = root;
  const ctx = {
    get: (key) =>
      key === 'agents' ? { get: (id) => ({ id, session: { header: { cwd } } }) } : undefined,
  };
  const store = new WorkflowStore(join(root, 'flows'));
  const selected = [{ id: 'ref', kind: 'chat', label: '核对范围', text: 'context'.repeat(12000) }];
  const prompt = '要求'.repeat(350) + '仅允许在测试环境部署';
  const flow = store.create(prompt, cwd, 0, {
    session: 's',
    template: { id: 'f', name: '审批', includeDiff: false, steps: [] },
    handoff: selected,
  });
  flow.round = 2;
  flow.status = 'waiting_approval';
  flow.stage = 'approval';
  flow.pendingApproval = { id: 'gate', node: 'a', name: '审批', instructions: '核对', inputs: [] };
  store.save(flow);
  const query = { id: flow.id, round: 2, sessionId: 's', approvalId: 'gate' };
  const progress = runProgress(ctx, query, store, false);
  assert.equal(progress.prompt, prompt.slice(0, 500));
  assert.ok(JSON.stringify(progress).length < 8000);
  assert.deepEqual(runApprovalContext(ctx, query, store), { prompt, sources: selected });
  for (const update of [{ round: 1 }, { approvalId: 'old' }, { approvalId: undefined }])
    assert.throws(() => runApprovalContext(ctx, { ...query, ...update }, store), /审批已失效/);
  assert.throws(() => runApprovalContext(ctx, { ...query, sessionId: 'other' }, store), /创建/);
  cwd = join(root, 'other');
  mkdirSync(cwd);
  assert.throws(() => runApprovalContext(ctx, query, store), /创建/);
  cwd = root;
  flow.dsh.handoff = [];
  store.save(flow);
  assert.deepEqual(runApprovalContext(ctx, query, store).sources, []);
  delete flow.dsh.handoff;
  store.save(flow);
  assert.equal(runApprovalContext(ctx, query, store).sources, null);
  flow.status = 'completed';
  store.save(flow);
  assert.throws(() => runApprovalContext(ctx, query, store), /审批已失效/);
});

test('progress and individual step details use the frozen round, scope, and execution', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sihq-progress-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'project');
  mkdirSync(cwd);
  const store = new WorkflowStore(join(dir, 'flows'));
  const runs = new RunStore(join(dir, 'runs'));
  const ctx = {
    get(name) {
      if (name === 'agents') return { get: (id) => ({ id, session: { header: { cwd } } }) };
    },
  };
  const template = {
    name: '模板',
    steps: [{ id: 'a', name: 'A', kind: 'read', backend: 'spawn' }],
  };
  const flow = store.create('Task', cwd, 0, { session: 's', template });
  const evidence = 'evidence'.repeat(12000) + 'end-of-evidence';
  const run = runs.create(flow.prompt, cwd);
  const priorId = randomUUID();
  const executionId = randomUUID();
  Object.assign(run, { workflowId: flow.id, executionId, status: 'completed' });
  runs.save(run);
  const entry = {
    node: 'a',
    runId: run.id,
    executionId: priorId,
    stage: 'read',
    status: 'completed',
    startedAt: run.createdAt,
    report: { summary: 'first', evidence: [evidence] },
  };
  flow.status = 'completed';
  flow.rounds = [{ ...flow, round: 1, steps: [entry] }];
  flow.round = 2;
  flow.steps = [
    { ...entry, executionId, report: { summary: 'latest', evidence: ['only-latest'] } },
  ];
  store.save(flow);
  const input = { prompt: 'historic prompt', structured: false };
  const inherited = { provider: 'test', model: 'inherited', reasoningEffort: 'medium' };
  writeFileSync(
    join(runs.directory(run.id), 'dsh-' + priorId + '.json'),
    JSON.stringify({ state: 'answered', childId: 'old-child', resolvedRoute: inherited }),
  );
  writeFileSync(
    join(runs.directory(run.id), 'dsh-input-' + priorId + '.json'),
    JSON.stringify(input),
  );

  const query = { sessionId: 's', id: flow.id, round: 1 };
  const progress = runProgress(ctx, query, store, false);
  assert.equal(progress.steps[0].summary, 'first');
  assert.ok(JSON.stringify(progress).length < 8000);
  assert.equal(progress.steps[0].report, undefined);
  assert.equal(progress.steps[0].input, undefined);
  assert.deepEqual(runProgress(ctx, { ...query, revision: progress.revision }, store, false), {
    revision: progress.revision,
    unchanged: true,
    status: 'completed',
  });
  assert.equal(progress.canContinue, false);
  assert.equal(runProgress(ctx, { ...query, round: 2 }, store, false).canContinue, true);

  const opened = await runStep(ctx, { ...query, index: 0 }, store, runs);
  assert.deepEqual(opened.resolvedRoute, inherited);
  assert.deepEqual(opened.input, input);
  assert.equal(opened.report.evidence[0], evidence);
  const latest = await runStep(ctx, { ...query, index: 0, round: 2 }, store, runs);
  assert.equal(latest.resolvedRoute, undefined);
  assert.deepEqual(latest.report.evidence, ['only-latest']);
  assert.equal(latest.input, undefined);
  assert.throws(() => runProgress(ctx, { ...query, sessionId: 'other' }, store, false), /创建/);
  await assert.rejects(
    () => runStep(ctx, { ...query, sessionId: 'other', index: 0 }, store, runs),
    /创建/,
  );
  await assert.rejects(() => runStep(ctx, { ...query, index: 1 }, store, runs), /步骤/);
});
