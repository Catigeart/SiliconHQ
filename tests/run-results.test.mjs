import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { lockFile } from '../dist/storage/lock.js';
import { describeRun, formatRunResult } from '../run-results.js';
import { scopedFlow, scopedFlowForAgent } from '../dsh-workspace.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'sihq-report-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const records = new Map();
  const runs = {
    read(id) {
      const run = records.get(id);
      if (!run) throw Error('missing record');
      return run;
    },
    directory(id) {
      return join(root, id);
    },
  };
  const flow = {
    id: randomUUID(),
    prompt: 'original',
    cwd: root,
    stage: 'read',
    status: 'completed',
    round: 1,
    steps: [],
  };
  function run(extra) {
    const id = randomUUID();
    const data = {
      id,
      executionId: randomUUID(),
      cwd: root,
      workflowId: flow.id,
      status: 'completed',
      ...extra,
    };
    records.set(id, data);
    mkdirSync(runs.directory(id));
    return data;
  }
  return { flow, runs, run, root };
}

test('DSH history is scoped to its session and workspace, legacy history to its workspace', (t) => {
  const { flow, root } = setup(t);
  const second = join(root, 'other');
  mkdirSync(second);
  const store = {
    read() {
      return flow;
    },
  };
  const agent = { id: 'one', session: { header: { cwd: root } } };
  const ctx = {
    get() {
      return { get: (id) => (id === 'one' ? agent : undefined) };
    },
  };
  flow.dsh = { session: 'one' };
  assert.equal(scopedFlow(ctx, 'one', flow.id, store), flow);
  assert.throws(() => scopedFlow(ctx, 'gone', flow.id, store), /会话/);
  assert.throws(() => scopedFlowForAgent({ ...agent, id: 'two' }, flow.id, store), /创建/);
  const otherAgent = { ...agent, session: { header: { cwd: second } } };
  assert.throws(() => scopedFlowForAgent(otherAgent, flow.id, store), /创建/);
  delete flow.dsh;
  assert.equal(scopedFlowForAgent({ ...agent, id: 'two' }, flow.id, store), flow);
  assert.throws(() => scopedFlowForAgent(otherAgent, flow.id, store), /创建/);
});

test('custom report details keep both evidence arrays and frozen routes while the chat result stays bounded', (t) => {
  const { flow, runs, run } = setup(t);
  const steps = ['first', 'last'].map((id) => ({
    id,
    name: id,
    kind: 'read',
    backend: 'spawn',
    provider: 'fixture',
    model: id,
    reasoningEffort: 'high',
    instanceName: id,
  }));
  flow.dsh = { session: 'one', template: { name: 'Evidence', steps } };
  for (const step of steps) {
    const data = run({ threadId: 'child-' + step.id });
    flow.steps.push({
      node: step.id,
      stage: 'read',
      runId: data.id,
      executionId: data.executionId,
      status: 'completed',
      report: {
        summary: 'summary-' + step.id,
        evidence: ['evidence-' + step.id],
      },
    });
  }
  let detail = describeRun(flow, runs);
  assert.equal(detail.steps[0].model, 'first');
  assert.equal(detail.steps[0].reasoningEffort, 'high');
  assert.equal(detail.steps[1].instanceName, 'last');
  assert.equal(detail.steps[1].childId, 'child-last');
  assert.match(
    formatRunResult(detail),
    /summary-first[\s\S]*evidence-first[\s\S]*summary-last[\s\S]*evidence-last/,
  );
  flow.steps[0].report.evidence = ['x'.repeat(70000)];
  detail = describeRun(flow, runs);
  const result = formatRunResult(detail);
  assert.ok(result.length < 17000);
  assert.match(result, /evidence-last/);
  assert.equal(detail.steps[0].report.evidence[0].length, 70000);
});

test('reading a previous round keeps its former attempt separate from a repair sharing its runId', (t) => {
  const { flow, runs, run } = setup(t);
  const latest = run({ role: 'developer', threadId: 'new-child' });
  const former = randomUUID();
  flow.dsh = {
    session: 'one',
    roles: { developer: { backend: 'spawn', model: 'development' } },
  };
  flow.steps = [
    {
      stage: 'implement',
      runId: latest.id,
      executionId: former,
      status: 'completed',
    },
  ];
  writeFileSync(
    join(runs.directory(latest.id), 'dsh-' + former + '.json'),
    JSON.stringify({
      state: 'answered',
      answer: JSON.stringify({ summary: 'original edit' }),
      childId: 'former-child',
      observedModel: 'actual',
    }),
  );
  flow.rounds = [{ ...flow, status: 'failed' }];
  flow.round = 2;
  flow.prompt = 'next';
  flow.steps = [
    {
      stage: 'repair',
      runId: latest.id,
      executionId: latest.executionId,
      status: 'completed',
    },
  ];
  writeFileSync(
    join(runs.directory(latest.id), 'implementation.json'),
    JSON.stringify({ summary: 'second edit' }),
  );
  const old = describeRun(flow, runs, 1);
  assert.equal(old.canRetry, false);
  assert.equal(old.steps[0].report.summary, 'original edit');
  assert.equal(old.steps[0].childId, 'former-child');
  assert.equal(old.steps[0].observedModel, 'actual');
  const current = describeRun(flow, runs);
  assert.equal(current.steps[0].report.summary, 'second edit');
  assert.equal(current.steps[0].childId, 'new-child');
  assert.deepEqual(
    current.rounds.map((r) => r.round),
    [1, 2],
  );
  assert.throws(() => describeRun(flow, runs, 3), /找不到所选轮次/);
});

test('conditional skips and pending human decisions are delivered without a provider run', (t) => {
  const { flow, runs } = setup(t);
  flow.dsh = {
    session: 'one',
    template: {
      name: 'Gate',
      steps: [
        { id: 'fix', name: '修复', kind: 'implement' },
        { id: 'ok', name: '确认', kind: 'approval' },
      ],
    },
  };
  flow.stage = 'approval';
  flow.status = 'waiting_approval';
  flow.steps = [
    {
      node: 'fix',
      stage: 'implement',
      status: 'skipped',
      skipReason: '检查通过，无需修复',
    },
  ];
  flow.pendingApproval = {
    id: 'decision',
    node: 'ok',
    name: '确认',
    instructions: '检查交付件',
    inputs: ['fix'],
  };
  const detail = describeRun(flow, runs);
  assert.equal(detail.steps[0].skipReason, flow.steps[0].skipReason);
  assert.equal(detail.pendingApproval.id, 'decision');
  assert.match(formatRunResult(detail), /待确认 · 确认[\s\S]*检查交付件[\s\S]*检查通过，无需修复/);
  flow.rounds = [{ ...flow }];
  flow.round = 2;
  assert.equal(describeRun(flow, runs, 1).pendingApproval, undefined);
});

test('details offer crash recovery only after the live owner is gone, without acquiring a lock', (t) => {
  const { flow, runs, root } = setup(t);
  flow.status = 'running';
  const store = { directory: () => root };
  const detail = (options) => describeRun(flow, runs, undefined, { store, ...options });
  assert.equal(detail().interrupted, true);
  assert.equal(detail().canResume, true);
  assert.equal(detail({ active: true }).canResume, false);
  assert.deepEqual(readdirSync(root), []);
  const file = join(root, 'lock');
  const exited = spawnSync(process.execPath, ['-e', '']);
  assert.equal(exited.status, 0);
  writeFileSync(file, String(exited.pid));
  assert.equal(detail().canResume, true);
  assert.deepEqual(readdirSync(root), ['lock']);
  writeFileSync(file, String(process.pid));
  assert.equal(detail().canResume, false);
  assert.equal(detail().interrupted, false);
  writeFileSync(file, 'broken');
  assert.match(detail().lockError, /运行锁/);
  assert.equal(detail().canResume, false);
  rmSync(file);
  const unlock = lockFile(file);
  try {
    // The transactional row alone remains authoritative if the mirror disappears.
    rmSync(file);
    assert.equal(detail().canResume, false);
  } finally {
    unlock();
  }
  assert.equal(detail().canResume, true);
});
