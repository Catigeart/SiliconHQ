import { checkRecoveryPages } from './recovery-model.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { previewStepInput, runTemplate } from '../template-runner.js';
import { workflowTemplateSchema } from '../workflow-templates.js';
import { WorkflowStore } from '../dist/storage/workflows.js';
import { RunStore } from '../dist/storage/runs.js';
import { lockWorkspace } from '../dist/storage/workspace-lock.js';

const step = (id, kind = 'read', extra = {}) => ({
  id,
  name: id,
  kind,
  backend: kind === 'approval' ? 'human' : 'spawn',
  instructions: 'Inspect ' + id,
  inputs: [],
  ...extra,
});
const readReport = (id) => ({ summary: id, evidence: ['Evidence from ' + id] });

function fixture(t, steps, dispatch = async (node) => readReport(node.id), globalBudget = 1) {
  const dir = mkdtempSync(join(tmpdir(), 'sihq-controls-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'workspace');
  mkdirSync(cwd);
  const stores = () => ({
    runs: new RunStore(join(dir, 'runs')),
    flows: new WorkflowStore(join(dir, 'flows')),
  });
  const calls = [];
  const template = workflowTemplateSchema.parse({ id: 'fixture', name: 'test', steps });
  return {
    cwd,
    stores,
    calls,
    run(request, signal = new AbortController().signal, replacement) {
      return runTemplate({
        request,
        replacement,
        cwd,
        frozen: { session: 'test', template },
        ...stores(),
        signal,
        globalBudget,
        observer: { onStage() {}, onUpdate() {}, onDispatch() {}, log() {} },
        async delegate(node, spec) {
          calls.push({ node: node.id, ...spec });
          return JSON.stringify(await dispatch(node, spec));
        },
      });
    },
  };
}

test('reassigning parallel failures handles exactly one attempt per confirmation', async (t) => {
  const steps = ['red', 'green', 'blue'].map((id) => step(id, 'read', { parallelGroup: 'checks' }));
  const replacement = { backend: 'spawn', model: 'deep', instanceId: 'deep' };
  const f = fixture(t, steps, async (node) => {
    if (node.id !== 'green' && node.model !== 'deep') throw Error('quota');
    return readReport(node.id);
  });
  const first = await f.run({ action: 'start', prompt: 'review' });
  assert.equal(first.status, 'failed');
  const act = (entry) =>
    f.run(
      { action: 'reassign', id: first.id, executionId: entry.executionId, confirmed: true },
      undefined,
      replacement,
    );
  const second = await act(first.steps[0]);
  assert.equal(second.status, 'failed');
  assert.equal(second.steps[0].previousAttempts[0].error, 'quota');
  assert.equal(second.steps[0].routeOverride.model, 'deep');
  assert.deepEqual(
    f.calls.map((c) => c.node),
    ['red', 'green', 'blue', 'red'],
  );
  await assert.rejects(act(first.steps[0]), /已变更/);
  const third = await act(first.steps[2]);
  assert.equal(third.status, 'completed');
  assert.deepEqual(
    f.calls.map((c) => c.node),
    ['red', 'green', 'blue', 'red', 'blue'],
  );
});

test('approval survives reopening, releases locks, and consumes only the pending gate', async (t) => {
  const f = fixture(t, [
    step('first'),
    step('approve-plan', 'approval', { inputs: ['first'] }),
    step('second', 'read', { inputs: ['approve-plan'] }),
    step('approve-output', 'approval', { inputs: ['second'] }),
  ]);
  const waiting = await f.run({ action: 'start', prompt: 'Task' });
  const id = waiting.id;
  const token = waiting.pendingApproval.id;
  assert.equal(waiting.status, 'waiting_approval');
  assert.deepEqual(waiting.pendingApproval.inputs, ['first']);
  assert.deepEqual(f.stores().flows.read(id).pendingApproval, waiting.pendingApproval);
  const release = lockWorkspace(f.cwd);
  release();
  const releaseFlow = f.stores().flows.lock(id);
  releaseFlow();
  const resumed = await f.run({ action: 'resume', id });
  assert.equal(resumed.pendingApproval.id, token);
  assert.deepEqual(
    f.calls.map((c) => c.node),
    ['first'],
  );
  await assert.rejects(f.run({ action: 'approve', id, approvalId: 'outdated' }));
  assert.deepEqual(f.stores().flows.read(id).pendingApproval, waiting.pendingApproval);
  const next = await f.run({ action: 'approve', id, approvalId: token, note: 'Reviewed the plan' });
  assert.equal(next.status, 'waiting_approval');
  assert.notEqual(next.pendingApproval.id, token);
  assert.deepEqual(
    f.calls.map((c) => c.node),
    ['first', 'second'],
  );
  assert.match(f.calls[1].prompt, /"decision":"approved"/);
  assert.match(f.calls[1].prompt, /Reviewed the plan/);
  await assert.rejects(f.run({ action: 'reject', id, approvalId: token }));
  const finished = await f.run({ action: 'approve', id, approvalId: next.pendingApproval.id });
  assert.equal(finished.status, 'completed');
  assert.equal(finished.pendingApproval, undefined);
  assert.deepEqual(
    finished.steps.filter((s) => s.stage === 'approval').map((s) => s.report.decision),
    ['approved', 'approved'],
  );
  await assert.rejects(f.run({ action: 'approve', id, approvalId: next.pendingApproval.id }));
});

test('rejecting a gate is terminal and records the decision without starting downstream work', async (t) => {
  const f = fixture(t, [step('gate', 'approval'), step('write', 'develop')]);
  const waiting = await f.run({ action: 'start', prompt: 'Require approval' });
  const id = waiting.id;
  const denied = await f.run({
    action: 'reject',
    id,
    approvalId: waiting.pendingApproval.id,
    note: 'Need more detail',
  });
  assert.equal(denied.status, 'rejected');
  const report = f.stores().flows.read(id).steps.at(-1).report;
  assert.equal(report.note, 'Need more detail');
  assert.equal(report.decision, 'rejected');
  assert.equal((await f.run({ action: 'resume', id })).status, 'rejected');
  await assert.rejects(f.run({ action: 'approve', id, approvalId: waiting.pendingApproval.id }));
  assert.deepEqual(f.calls, []);
});

const group = { parallelGroup: 'pair' };
test('a human return preserves its history, supplies feedback, and demands a fresh approval', async (t) => {
  let outcome = 'implemented';
  const f = fixture(
    t,
    [
      step('intro'),
      step('checkpoint', 'approval'),
      step('develop', 'develop'),
      step('notes', 'read', { inputs: ['develop'] }),
      step('gate', 'approval', { when: { source: 'develop', equals: 'implemented' } }),
      step('finish', 'read', { inputs: ['develop', 'gate'] }),
    ],
    (node) => (node.kind === 'develop' ? developmentReport(outcome) : readReport(node.id)),
  );
  let waiting = await f.run({ action: 'start', prompt: 'Task' });
  const id = waiting.id;
  waiting = await f.run({ action: 'approve', id, approvalId: waiting.pendingApproval.id });
  const gate = waiting.pendingApproval;
  assert.deepEqual(
    gate.returnTargets.map(({ id }) => id),
    ['develop', 'notes'],
  );
  const rewind = {
    action: 'return',
    id,
    approvalId: gate.id,
    target: 'develop',
    note: 'Include the migration',
  };
  await assert.rejects(f.run({ ...rewind, note: '   ' }), /决定说明/);
  await assert.rejects(f.run({ ...rewind, target: 'intro' }), /串行/);
  assert.equal(f.stores().flows.read(id).pendingApproval.id, gate.id);
  outcome = 'incomplete';
  const again = await f.run(rewind);
  assert.equal(again.status, 'waiting_approval');
  assert.notEqual(again.pendingApproval.id, gate.id);
  assert.equal(again.repairCount, 1);
  assert.deepEqual(
    f.calls.map((c) => c.node),
    ['intro', 'develop', 'notes', 'develop', 'notes'],
  );
  assert.match(f.calls[3].prompt, /Include the migration/);
  assert.match(f.calls[3].prompt, /"outcome":"implemented"/);
  assert.ok(f.calls[3].inputSources.some((s) => s.id === gate.id && s.kind === 'feedback'));
  assert.match(f.calls[4].prompt, /"outcome":"incomplete"/);
  const original = again.steps.find((s) => s.node === 'develop');
  assert.equal(original.supersededByApproval, gate.id);
  assert.equal(again.steps.find((s) => s.runId === gate.id).report.decision, 'returned');
  await assert.rejects(f.run(rewind), /确认已失效/);
  await assert.rejects(f.run({ ...rewind, approvalId: again.pendingApproval.id }), /已用尽/);
  const finished = await f.run({ action: 'approve', id, approvalId: again.pendingApproval.id });
  assert.equal(finished.status, 'incomplete');
  assert.match(f.calls.at(-1).prompt, /"decision":"approved"/);
});

const parallelTemplate = () => [
  step('left', 'read', group),
  step('right', 'read', group),
  step('combine', 'read', { inputs: ['left', 'right'] }),
];

test('automatic review repair cannot rewind past the requested human return', async (t) => {
  let verdict = 'passed';
  const f = fixture(
    t,
    [
      step('early', 'develop'),
      step('inspect'),
      step('review', 'review', { returnTo: 'early', maxRepairs: 2 }),
      step('gate', 'approval'),
    ],
    (node) =>
      node.kind === 'review'
        ? reviewReport(verdict)
        : node.kind === 'develop'
          ? developmentReport('implemented')
          : readReport(node.id),
    2,
  );
  const waiting = await f.run({ action: 'start', prompt: 'Task' });
  verdict = 'changes_requested';
  const partial = await f.run({
    action: 'return',
    id: waiting.id,
    approvalId: waiting.pendingApproval.id,
    target: 'inspect',
    note: 'Recheck the finding',
  });
  assert.equal(partial.status, 'changes_requested');
  assert.equal(partial.stopReason, 'repair_outside_approved_return');
  assert.equal(partial.repairCount, 1);
  assert.deepEqual(
    f.calls.map((call) => call.node),
    ['early', 'inspect', 'review', 'inspect', 'review'],
  );
});

async function within(promise) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Parallel execution did not reach barrier')),
          5000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

test('readonly siblings overlap and downstream receives reports after both finish', async (t) => {
  const bothStarted = Promise.withResolvers();
  const gates = { left: Promise.withResolvers(), right: Promise.withResolvers() };
  const active = new Set();
  const f = fixture(t, parallelTemplate(), async ({ id }) => {
    if (Object.hasOwn(gates, id)) {
      active.add(id);
      if (active.size === 2) bothStarted.resolve();
      await gates[id].promise;
    }
    return readReport(id);
  });
  const work = f.run({ action: 'start', prompt: 'Task' });
  try {
    await within(bothStarted.promise);
    gates.right.resolve();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      f.calls.map((c) => c.node),
      ['left', 'right'],
    );
  } finally {
    gates.left.resolve();
    gates.right.resolve();
    await work;
  }
  const flow = await work;
  assert.equal(flow.status, 'completed');
  assert.match(f.calls[2].prompt, /Evidence from left/);
  assert.match(f.calls[2].prompt, /Evidence from right/);
});

test('retry of a failed parallel group preserves its successful sibling', async (t) => {
  let attempts = 0;
  const f = fixture(t, parallelTemplate(), async ({ id }) => {
    if (id === 'right' && ++attempts === 1) throw new Error('transient right failure');
    return readReport(id);
  });
  const failed = await f.run({ action: 'start', prompt: 'Task' });
  assert.equal(failed.status, 'failed');
  const originalLeft = failed.steps.find((s) => s.node === 'left');
  assert.equal(originalLeft.status, 'completed');
  const resumed = await f.run({ action: 'retry', id: failed.id });
  assert.equal(resumed.status, 'completed');
  assert.equal(resumed.steps.find((s) => s.node === 'left').runId, originalLeft.runId);
  assert.deepEqual(
    f.calls.map((c) => c.node),
    ['left', 'right', 'right', 'combine'],
  );
  assert.match(f.calls.at(-1).prompt, /Evidence from left/);
});

test('cancelling a parallel group cancels both running jobs and releases the workspace', async (t) => {
  const controller = new AbortController();
  const bothStarted = Promise.withResolvers();
  let count = 0;
  const f = fixture(t, parallelTemplate(), async ({ id }, spec) => {
    if (++count === 2) bothStarted.resolve();
    await new Promise((_, reject) => {
      spec.active.throwIfAborted();
      spec.active.addEventListener('abort', () => reject(spec.active.reason), { once: true });
    });
    return readReport(id);
  });
  const work = f.run({ action: 'start', prompt: 'Task' }, controller.signal);
  try {
    await within(bothStarted.promise);
  } finally {
    controller.abort();
    await within(work);
  }
  const result = await work;
  assert.equal(result.status, 'cancelled');
  assert.deepEqual(
    result.steps.map((entry) => entry.status),
    ['cancelled', 'cancelled'],
  );
  assert.equal(f.calls.length, 2);
  const release = lockWorkspace(f.cwd);
  release();
});

function reviewReport(verdict) {
  return {
    verdict,
    summary: verdict,
    criteria: [
      {
        criterion: 'Task',
        result: { passed: 'passed', changes_requested: 'failed', blocked: 'not_verified' }[verdict],
        evidence: 'Fixture evidence',
      },
    ],
    findings: [],
    checks: [],
    limitations: verdict === 'blocked' ? ['Missing supporting evidence'] : [],
  };
}

function developmentReport(outcome) {
  return {
    outcome,
    summary: outcome,
    changes: [],
    validations: [],
    remaining: outcome === 'incomplete' ? ['One task remains'] : [],
  };
}

test('an unhandled incomplete report survives trailing work, skipped branches and later rounds', async (t) => {
  let outcome = 'incomplete';
  for (const tail of [
    [],
    [step('log')],
    [step('approved', 'approval', { when: { source: 'implement', equals: 'implemented' } })],
  ]) {
    outcome = 'incomplete';
    const f = fixture(t, [step('implement', 'develop'), ...tail], async (node) =>
      node.kind === 'develop' ? developmentReport(outcome) : readReport(node.id),
    );
    const first = await f.run({ action: 'start', prompt: 'Task' });
    assert.equal(first.status, 'incomplete');
    assert.match(first.error, /implement.*One task remains/);
    const entry = f.stores().flows.read(first.id).steps[0];
    assert.equal(entry.status, 'completed');
    assert.deepEqual(entry.report, developmentReport('incomplete'));
    assert.equal(f.stores().runs.read(entry.runId).implementationOutcome, 'incomplete');
    assert.equal((await f.run({ action: 'resume', id: first.id })).status, 'incomplete');
    outcome = 'implemented';
    const second = await f.run({ action: 'continue', id: first.id, prompt: 'Finish it' });
    assert.equal(second.rounds[0].status, 'incomplete');
    assert.deepEqual(second.rounds[0].steps[0].report, entry.report);
    assert.equal(second.status, tail[0]?.kind === 'approval' ? 'waiting_approval' : 'completed');
    assert.equal(second.error, undefined);
  }
});

test('approval only consumes an incomplete outcome when the gate explicitly handles it', async (t) => {
  for (const handles of [false, true]) {
    const f = fixture(
      t,
      [
        step('dev', 'develop'),
        step(
          'accept',
          'approval',
          handles ? { when: { source: 'dev', equals: 'incomplete' } } : { inputs: ['dev'] },
        ),
      ],
      async () => developmentReport('incomplete'),
    );
    const pending = await f.run({ action: 'start', prompt: 'Task' });
    assert.equal(pending.status, 'waiting_approval');
    const closed = await f.run({
      action: 'approve',
      id: pending.id,
      approvalId: pending.pendingApproval.id,
    });
    assert.equal(closed.status, handles ? 'completed' : 'incomplete');
  }
});

test('automatic repair supersedes a conditional writer that is skipped on the second pass', async (t) => {
  let attempts = 0;
  const f = fixture(
    t,
    [
      step('build', 'develop'),
      step('extra', 'develop', { when: { source: 'build', equals: 'incomplete' } }),
      step('audit', 'review', { returnTo: 'build', maxRepairs: 1 }),
    ],
    ({ id }) =>
      id === 'build'
        ? developmentReport(++attempts === 1 ? 'incomplete' : 'implemented')
        : id === 'extra'
          ? developmentReport('incomplete')
          : reviewReport(attempts === 1 ? 'changes_requested' : 'passed'),
  );
  const flow = await f.run({ action: 'start', prompt: 'Task' });
  assert.equal(flow.status, 'passed', flow.error);
  assert.equal(flow.steps[1].supersededByRepair, flow.steps[2].runId);
  assert.equal(flow.steps[4].status, 'skipped');
});

test('preview renders the conditional prompt sections through the runtime formatter', () => {
  const build = step('dev', 'develop');
  const preview = (node, scenario, repair) =>
    previewStepInput({ step: node, inputs: [], repair, scenario, references: true }).prompt;
  assert.doesNotMatch(preview(build, ''), /人工退回修改意见/);
  assert.match(preview(build, 'human'), /人工退回修改意见：[\s\S]+本步骤上次的报告/);
  assert.match(preview(build, '', 'verify'), /验证失败报告/);
  assert.match(
    preview(step('review', 'review', { reviewPolicy: 'blocking' }), 'recheck'),
    /上次审查阻塞项与待复验事项/,
  );
  assert.match(preview(build, ''), /本轮选择的参考资料/);
});

test('a skipped gate allows a later active approval to return to the writer', async (t) => {
  const f = fixture(
    t,
    [
      step('dev', 'develop'),
      step('conditional', 'approval', { when: { source: 'dev', equals: 'incomplete' } }),
      step('gate', 'approval'),
    ],
    () => developmentReport('implemented'),
  );
  const flow = await f.run({ action: 'start', prompt: 'Task' });
  assert.deepEqual(
    flow.pendingApproval.returnTargets.map((t) => t.id),
    ['dev'],
  );
  const next = await f.run({
    action: 'return',
    id: flow.id,
    approvalId: flow.pendingApproval.id,
    target: 'dev',
    note: 'add tests',
  });
  assert.equal(next.pendingApproval.node, 'gate');
  assert.notEqual(next.pendingApproval.id, flow.pendingApproval.id);
});

test('successful repair replaces a prior incomplete attempt in the same round', async (t) => {
  let attempts = 0;
  const f = fixture(
    t,
    [
      step('build', 'develop'),
      step('verify', 'review', {
        returnTo: 'build',
        maxRepairs: 1,
      }),
    ],
    async (node) =>
      node.kind === 'develop'
        ? developmentReport(++attempts === 1 ? 'incomplete' : 'implemented')
        : reviewReport(attempts === 1 ? 'changes_requested' : 'passed'),
  );
  const flow = await f.run({ action: 'start', prompt: 'Task' });
  assert.equal(flow.status, 'passed', flow.error);
  assert.equal(flow.repairCount, 1);
  assert.deepEqual(
    flow.steps.filter((s) => s.node === 'build').map((s) => s.report.outcome),
    ['incomplete', 'implemented'],
  );
});

test('an unreachable repair target retains the review without spending budget or dispatching a second review', async (t) => {
  const f = fixture(
    t,
    [
      step('build', 'develop'),
      step('extra', 'develop', { when: { source: 'build', equals: 'incomplete' } }),
      step('verify', 'review', { returnTo: 'extra', maxRepairs: 1 }),
    ],
    async (node) =>
      node.kind === 'develop'
        ? developmentReport('implemented')
        : reviewReport('changes_requested'),
  );
  const flow = await f.run({ action: 'start', prompt: 'Task' });
  assert.deepEqual(
    f.calls.map((c) => c.node),
    ['build', 'verify'],
  );
  assert.equal(flow.status, 'changes_requested');
  assert.equal(flow.repairCount, 0);
  assert.equal(flow.stopReason, 'repair_target_skipped');
  assert.match(flow.error, /extra/);
  assert.equal(flow.steps.at(-1).report.verdict, 'changes_requested');
});

test('a repair waiting for admission is counted once when accepted after recovery', async (t) => {
  let repairs = 0;
  const f = fixture(
    t,
    [step('build', 'develop'), step('verify', 'review', { returnTo: 'build', maxRepairs: 1 })],
    async (node, spec) => {
      if (node.kind === 'review') return reviewReport(repairs ? 'passed' : 'changes_requested');
      if (spec.prompt.includes('独立审查退回意见')) {
        if (++repairs === 1) {
          spec.onWaiting();
          throw new Error('测试名额超时');
        }
        spec.onChild('accepted');
      }
      return developmentReport('implemented');
    },
  );
  const stopped = await f.run({ action: 'start', prompt: 'Task' });
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.repairCount, 0);
  const finished = await f.run({ action: 'resume', id: stopped.id });
  assert.equal(finished.status, 'passed');
  assert.equal(finished.repairCount, 1);
  assert.equal(finished.graph.counts.verify, 1);
});

test('an incomplete handler transfers its own unfinished work without clearing unrelated work', async (t) => {
  const f = fixture(
    t,
    [
      step('primary', 'develop'),
      step('secondary', 'develop'),
      step('follow-up', 'develop', { when: { source: 'primary', equals: 'incomplete' } }),
      step('done', 'review'),
    ],
    async ({ kind, id }) =>
      kind === 'review'
        ? reviewReport('passed')
        : { ...developmentReport('incomplete'), remaining: ['open ' + id] },
  );
  const flow = await f.run({ action: 'start', prompt: 'Task' });
  assert.equal(flow.status, 'incomplete');
  assert.doesNotMatch(flow.error, /open primary/);
  assert.match(flow.error, /open secondary/);
  assert.match(flow.error, /open follow-up/);
  assert.match(flow.steps[0].report.remaining[0], /open primary/);
});

for (const [kind, outcomes, report] of [
  ['review', ['passed', 'changes_requested', 'blocked'], reviewReport],
  ['develop', ['implemented', 'incomplete'], developmentReport],
]) {
  for (const result of outcomes) {
    test(kind + ' routes ' + result + ' and persists skipped alternatives', async (t) => {
      const branches = outcomes.map((equals) =>
        step(equals, 'read', { when: { source: 'source', equals } }),
      );
      const f = fixture(
        t,
        [step('source', kind), ...branches, step('join', 'read', { inputs: outcomes })],
        async ({ id }) => (id === 'source' ? report(result) : readReport(id)),
      );
      const flow = await f.run({ action: 'start', prompt: 'Task' });
      assert.equal(flow.status, 'completed', flow.error);
      assert.deepEqual(
        f.calls.map((c) => c.node),
        ['source', result, 'join'],
      );
      const store = f.stores().runs;
      for (const outcome of outcomes) {
        const expected = outcome === result ? 'completed' : 'skipped';
        const entry = flow.steps.find((s) => s.node === outcome);
        assert.equal(entry.status, expected);
        assert.equal(store.read(entry.runId).status, expected);
      }
      const joinPrompt = f.calls.at(-1).prompt;
      assert.match(joinPrompt, new RegExp('Evidence from ' + result));
      for (const skipped of outcomes.filter((value) => value !== result)) {
        assert.doesNotMatch(joinPrompt, new RegExp('Evidence from ' + skipped));
      }
    });
  }
}

for (const verdict of ['blocked', 'changes_requested']) {
  test('a passed branch leaves an unhandled review ' + verdict + ' terminal', async (t) => {
    const f = fixture(
      t,
      [
        step('review', 'review'),
        step('publish', 'read', { when: { source: 'review', equals: 'passed' } }),
        step('later'),
      ],
      async ({ id }) => (id === 'review' ? reviewReport(verdict) : readReport(id)),
    );
    const flow = await f.run({ action: 'start', prompt: 'Task' });
    assert.equal(flow.status, verdict);
    assert.deepEqual(
      f.calls.map((c) => c.node),
      ['review'],
    );
  });
}

test('schema rejects unsafe parallel groups and invalid conditional references', () => {
  const sibling = (id, extra = {}) => step(id, 'read', { ...group, ...extra });
  const condition = (source, equals) => ({ when: { source, equals } });
  const invalid = [
    [sibling('single')],
    [sibling('one'), sibling('two'), step('gap'), sibling('three'), sibling('four')],
    [sibling('one'), step('write', 'develop', group)],
    [sibling('one'), step('gate', 'approval', group)],
    [sibling('one'), sibling('two', { inputs: ['one'] })],
    [step('review', 'review', group), sibling('two', condition('review', 'passed'))],
    [step('maybe', 'read', condition('later', 'passed')), step('later', 'review')],
    [step('dev', 'develop'), step('maybe', 'read', condition('dev', 'passed'))],
    [step('read'), step('maybe', 'read', condition('read', 'incomplete'))],
    [
      step('dev', 'develop'),
      step('review', 'review', { returnTo: 'dev' }),
      step('maybe', 'read', condition('review', 'passed')),
    ],
  ];
  for (const steps of invalid) {
    assert.equal(
      workflowTemplateSchema.safeParse({ id: 'fixture', name: 'test', steps }).success,
      false,
      JSON.stringify(steps),
    );
  }
});

test('resume rechecks only the blocked reviewer in a parallel group', async (t) => {
  let reviewed = false;
  const f = fixture(
    t,
    [
      step('audit', 'review', group),
      step('records', 'read', group),
      step('join', 'read', { inputs: ['audit', 'records'] }),
    ],
    async ({ id }) => {
      if (id !== 'audit') return readReport(id);
      const report = reviewReport(reviewed ? 'passed' : 'blocked');
      reviewed = true;
      return report;
    },
  );
  const waiting = await f.run({ action: 'start', prompt: 'Task' });
  assert.equal(waiting.status, 'blocked');
  const recovered = await f.run({ action: 'resume', id: waiting.id });
  assert.equal(recovered.status, 'completed', recovered.error);
  assert.deepEqual(
    f.calls.map((c) => c.node),
    ['audit', 'records', 'audit', 'join'],
  );
  assert.match(f.calls.at(-1).prompt, /"verdict":"passed"/);
  assert.doesNotMatch(f.calls.at(-1).prompt, /"verdict":"blocked"/);
});

test('a skipped conditional approval neither pauses nor delegates its work', async (t) => {
  const f = fixture(
    t,
    [
      step('dev', 'develop', { name: '实现产品需求' }),
      step('need-human', 'approval', { when: { source: 'dev', equals: 'incomplete' } }),
    ],
    async () => developmentReport('implemented'),
  );
  const flow = await f.run({ action: 'start', prompt: 'Task' });
  assert.equal(flow.status, 'completed', flow.error);
  assert.equal(flow.pendingApproval, undefined);
  assert.equal(flow.steps.at(-1).status, 'skipped');
  assert.equal(
    flow.steps.at(-1).skipReason,
    '「实现产品需求」的结果为「已完成开发」，此步骤要求「未完成开发」',
  );
  assert.equal(f.stores().runs.read(flow.steps.at(-1).runId).status, 'skipped');
  assert.deepEqual(
    f.calls.map((c) => c.node),
    ['dev'],
  );
});

test('corrupt active cursor stops recovery before a checkpoint or agent call', async (t) => {
  const f = fixture(t, [step('one')], async () => {
    throw Error('offline');
  });
  const first = await f.run({ action: 'start', prompt: 'test' });
  const { flows } = f.stores();
  const damaged = flows.read(first.id);
  delete damaged.graph.cursor;
  flows.save(damaged);
  const before = flows.read(first.id);
  await assert.rejects(f.run({ action: 'resume', id: first.id }), /快照.*cursor/);
  assert.deepEqual(flows.read(first.id), before);
  assert.equal(f.calls.length, 1);
});

test('a valid-looking cursor cannot skip an unfinished predecessor', async (t) => {
  const f = fixture(t, [step('one'), step('two')], async () => {
    throw Error('offline');
  });
  const flow = await f.run({ action: 'start', prompt: 'task' });
  const { flows } = f.stores();
  flow.graph.cursor = 1;
  delete flow.graph.batch;
  flows.save(flow);
  const before = flows.read(flow.id);
  await assert.rejects(f.run({ action: 'resume', id: flow.id }), /cursor/);
  assert.deepEqual(flows.read(flow.id), before);
  assert.equal(f.calls.length, 1);
});

test('unversioned sequential recovery reuses the recorded attempt before upgrading its graph', async (t) => {
  let calls = 0;
  const f = fixture(t, [step('one')], async () => {
    if (!calls++) throw Error('offline');
    return { summary: 'ok', evidence: ['a'] };
  });
  const flow = await f.run({ action: 'start', prompt: 'task' });
  const { flows } = f.stores();
  delete flow.graph.batch;
  delete flow.graph.version;
  flows.save(flow);
  const result = await f.run({ action: 'resume', id: flow.id });
  assert.equal(result.status, 'completed', result.error);
  assert.equal(result.graph.version, 1);
  assert.equal(result.steps.length, 1);
  assert.equal(result.steps[0].runId, flow.steps[0].runId);
});

test('template retry obeys the attempt displayed on each page', async (t) => {
  await checkRecoveryPages(async () => {
    const seen = new Set();
    const f = fixture(
      t,
      ['A', 'B'].map((id) => step(id, 'develop')),
      (n) => {
        if (!seen.has(n.id)) {
          seen.add(n.id);
          throw Error('first attempt failed');
        }
        return developmentReport('implemented');
      },
    );
    const flow = await f.run({ action: 'start', prompt: 'test' });
    return {
      read: () => f.stores().flows.read(flow.id),
      callCount: () => f.calls.length,
      recover: (action, expectedState) => f.run({ action, id: flow.id, expectedState }),
    };
  });
});

test('continuation appends one snapshot without reading full archived history', async (t) => {
  const f = fixture(t, [step('one')]);
  let flow = await f.run({ action: 'start', prompt: '1' });
  const original = WorkflowStore.prototype.read;
  WorkflowStore.prototype.read = () => assert.fail('continuation read archived rounds');
  try {
    for (let i = 2; i <= 4; i++)
      flow = await f.run({ action: 'continue', id: flow.id, prompt: String(i) });
  } finally {
    WorkflowStore.prototype.read = original;
  }
  const { flows } = f.stores();
  assert.equal(flows.readCurrent(flow.id).archivedRounds, 3);
  const snapshots = flows.read(flow.id).rounds;
  assert.deepEqual(
    snapshots.map((s) => s.prompt),
    ['1', '2', '3'],
  );
  assert.ok(snapshots.every((s) => !('archivedRounds' in s)));
});
