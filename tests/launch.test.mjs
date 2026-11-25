import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../plugin.js';
import { hasActiveWorkflowJob, submitWorkflow } from '../native.js';
import { WorkflowStore } from '../dist/storage/workflows.js';
import { RunStore } from '../dist/storage/runs.js';

function chatFixture() {
  const events = [];
  const session = {
    id: 'chat',
    session: {
      header: { cwd: process.cwd() },
      snapshotEvents: () => events,
      eventAt: (seq) => events[seq],
      append(type, data) {
        const event = { type, data, seq: events.length };
        events.push(event);
        return event;
      },
    },
  };
  const config = {
    agentInstances: [{ id: 'tester', name: 'Tester', backend: 'spawn', model: 'quick' }],
    templates: [
      {
        id: 'review',
        name: 'Review',
        steps: [
          {
            id: 'check',
            kind: 'read',
            name: 'Check',
            instructions: 'check',
            backend: 'sihq-agent:tester',
          },
        ],
      },
    ],
  };
  const routes = new Map();
  const lookedUp = [];
  let jobsStarted = 0;
  let command;
  const ctx = {
    inject(names, cb) {
      if (names.includes('connection'))
        cb({
          connection: {
            fetch: {
              register(route) {
                routes.set(route.path, route);
              },
            },
          },
        });
    },
    commands: {
      register(c) {
        command = c;
      },
    },
    get(name) {
      if (name === 'agentPresets') return { resolve: async (id) => ({ id }) };
      if (name === 'agents') return { get: (id) => (id === session.id ? session : undefined) };
      if (name === 'subagents')
        return {
          getProvider(backend) {
            lookedUp.push(backend);
            return { capabilities: { agentPreset: true, agentOptions: true } };
          },
        };
      if (name === 'jobs')
        return {
          start() {
            jobsStarted++;
            return 'job-' + jobsStarted;
          },
        };
    },
  };
  apply(ctx, config);
  const call = async (method, payload) => {
    const path = '/api/sihqCatalog/' + method;
    const response = await routes.get(path).fetch(
      new Request('http://localhost' + path, {
        method: 'POST',
        body: JSON.stringify({ rpcId: 'test', payload }),
      }),
    );
    return (await response.json()).result;
  };
  const invoke = (token, agent = session) =>
    command.handler({
      agent,
      rawInput: JSON.stringify(['launch', token, 'do it']),
    });
  return {
    call,
    invoke,
    session,
    config,
    lookedUp,
    count: () => jobsStarted,
    reload: () => apply(ctx, config),
    direct: () => command.handler({ agent: session, rawInput: 'run review "Run from chat"' }),
  };
}

test('chat confirmation uses the previewed instance and returns its own one-time receipt', async () => {
  const { call, invoke, session, config, lookedUp, count, direct } = chatFixture();
  const prepared = await call('prepareLaunch', {
    sessionId: session.id,
    selected: 'review',
  });
  assert.equal(prepared.ok, true);
  const original = prepared.value.token;
  const request = { sessionId: session.id, selected: 'review', replaces: original };
  const refreshes = await Promise.all([
    call('prepareLaunch', request),
    call('prepareLaunch', request),
  ]);
  assert.equal(refreshes.filter((r) => r.ok).length, 1);
  assert.equal((await invoke(original)).kind, 'error');
  const { flow, token } = refreshes.find((r) => r.ok).value;
  assert.match(flow.summary, /Tester.+quick/);
  config.agentInstances[0].backend = 'changed-backend';
  config.templates[0].name = 'Replaced';
  assert.equal((await invoke(token, { ...session, id: 'unrelated' })).kind, 'error');
  lookedUp.length = 0;
  const competing = await Promise.all([invoke(token), invoke(token)]);
  assert.equal(competing.filter((result) => result.kind === 'success').length, 1);
  assert.match(competing.find((result) => result.kind === 'success').text, /Review 已启动/);
  assert.equal(count(), 1);
  assert.deepEqual([...new Set(lookedUp)], ['spawn']);
  assert.equal((await invoke(token)).kind, 'error');
  assert.equal((await call('launchReceipt', { sessionId: 'another', token })).ok, false);
  assert.equal(
    (await call('launchReceipt', { sessionId: session.id, token })).value.jobId,
    'job-1',
  );
  const launched = await direct();
  assert.match(launched.text, /DSH 后台任务 job-2/);
  assert.equal((await call('launchReceipt', { sessionId: 'another', token: 'job-2' })).ok, false);
  assert.equal(
    (await call('launchReceipt', { sessionId: session.id, token: 'job-2' })).value.jobId,
    'job-2',
  );
});

test('expired and reloaded previews cannot duplicate a launch whose acknowledgement was lost', async (t) => {
  const { call, invoke, count, reload } = chatFixture();
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const input = { sessionId: 'chat', selected: 'review' };
  const first = (await call('prepareLaunch', input)).value.token;
  now += 31 * 60_000;
  const refreshed = await Promise.all(
    [1, 2].map(() => call('prepareLaunch', { ...input, replaces: first })),
  );
  assert.equal(refreshed.filter((r) => r.ok).length, 1);
  const token = refreshed.find((r) => r.ok).value.token;
  assert.equal((await invoke(token)).kind, 'success');
  now += 61_000;
  for (const reset of [false, true]) {
    if (reset) reload();
    const retry = await call('prepareLaunch', { ...input, replaces: token });
    assert.equal(retry.ok, false);
    assert.match(retry.error.message, /本会话运行记录/);
    assert.equal((await invoke(token)).kind, 'error');
    for (const key of [first, token, 'job-1'])
      assert.equal(
        (await call('launchReceipt', { sessionId: 'chat', token: key })).value.jobId,
        'job-1',
      );
    assert.equal((await call('launchReceipt', { sessionId: 'other', token })).ok, false);
    assert.equal(count(), 1);
  }
  const fresh = (await call('prepareLaunch', input)).value.token;
  assert.equal((await invoke(fresh)).kind, 'success');
  assert.equal(count(), 2);
});

test('a delayed job publishes its flow ID and a human decision survives a removed provider', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sihq-gate-job-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stores = {
    flows: new WorkflowStore(join(dir, 'flows')),
    runs: new RunStore(join(dir, 'runs')),
  };
  const events = [];
  const parent = {
    id: 'chat',
    session: {
      header: { cwd: dir },
      append(type, data) {
        events.push({ type, data });
        return { seq: events.length - 1 };
      },
    },
  };
  const template = {
    id: 'gated',
    name: 'Gated',
    steps: [
      { id: 'gate', kind: 'approval', backend: 'human', name: 'Confirm', instructions: 'Inspect.' },
      { id: 'later', kind: 'read', backend: 'spawn', name: 'Check', instructions: 'Check.' },
    ],
  };
  const config = { templates: [template], selectedTemplate: template.id };
  const scheduled = [];
  let service = { getProvider: () => ({ capabilities: { agentPreset: true } }) };
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { resolve: async (id) => ({ id }) };
      if (name === 'subagents') return service;
      if (name === 'jobs')
        return {
          start(spec) {
            scheduled.push(() => spec.run({ append() {}, updateProgress() {} }).done);
            return 'job-' + scheduled.length;
          },
        };
    },
  };
  const submit = (request, flags = {}) =>
    submitWorkflow(ctx, config, parent, request, flags, new Set(), stores);
  for (const action of ['reject', 'approve']) {
    let receipt, ready;
    service = { getProvider: () => ({ capabilities: { agentPreset: true } }) };
    submit(
      { action: 'start', prompt: 'Run' },
      {
        onStarted(value, pending) {
          receipt = value;
          ready = pending;
        },
      },
    );
    assert.ok(receipt.jobId);
    assert.equal(receipt.flowId, undefined);
    const done = scheduled.shift()();
    assert.equal(hasActiveWorkflowJob(receipt.flowId), true);
    await ready;
    assert.ok(receipt.flowId);
    await Promise.resolve();
    const recorded = events.findLast(
      (e) => e.type === 'sihq/launch' && e.data.jobId === receipt.jobId,
    );
    assert.equal(recorded.data.flowId, receipt.flowId);
    assert.equal((await done).status, 'completed');
    assert.equal(hasActiveWorkflowJob(receipt.flowId), false);
    const waiting = stores.flows.read(receipt.flowId);
    assert.equal(waiting.status, 'waiting_approval');
    service = undefined;
    const decision = { action, id: waiting.id, approvalId: waiting.pendingApproval.id };
    assert.throws(() => submit({ ...decision, approvalId: 'old-gate' }), /确认已失效/);
    submit(decision);
    assert.throws(() => submit(decision), /已有 DSH 后台任务/);
    const result = await scheduled.shift()();
    const updated = stores.flows.read(waiting.id);
    if (action === 'reject') {
      assert.equal(result.status, 'completed');
      assert.equal(updated.status, 'rejected');
      assert.equal(updated.steps.length, 1);
    } else {
      assert.equal(result.status, 'failed');
      assert.equal(updated.steps[0].report.decision, 'approved');
      assert.match(result.detail, /spawn/);
    }
    assert.throws(() => submit(decision), /已处理/);
  }
});
