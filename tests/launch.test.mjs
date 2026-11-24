import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply } from '../plugin.js';
import { hasActiveWorkflowJob, submitWorkflow } from '../native.js';
import { WorkflowStore } from '../dist/storage/workflows.js';
import { RunStore } from '../dist/storage/runs.js';

test('chat confirmation uses the previewed instance and returns its own one-time receipt', async () => {
  const session = { id: 'chat', session: { header: { cwd: process.cwd() } } };
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
            return 'this-job';
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
  assert.equal(jobsStarted, 1);
  assert.deepEqual([...new Set(lookedUp)], ['spawn']);
  assert.equal((await invoke(token)).kind, 'error');
  assert.equal((await call('launchReceipt', { sessionId: 'another', token })).ok, false);
  assert.equal(
    (await call('launchReceipt', { sessionId: session.id, token })).value.jobId,
    'this-job',
  );
  const direct = await command.handler({ agent: session, rawInput: 'run review "Run from chat"' });
  assert.match(direct.text, /DSH 后台任务 this-job/);
  assert.equal(
    (await call('launchReceipt', { sessionId: 'another', token: 'this-job' })).ok,
    false,
  );
  assert.equal(
    (await call('launchReceipt', { sessionId: session.id, token: 'this-job' })).value.jobId,
    'this-job',
  );
});

test('a delayed job publishes its flow ID and a human decision survives a removed provider', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sihq-gate-job-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const stores = {
    flows: new WorkflowStore(join(dir, 'flows')),
    runs: new RunStore(join(dir, 'runs')),
  };
  const parent = { id: 'chat', session: { header: { cwd: dir } } };
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
