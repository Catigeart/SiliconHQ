import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startWithCapacity } from '../admission.js';
import { submitWorkflow } from '../native.js';
import { WorkflowStore } from '../dist/storage/workflows.js';
import { RunStore } from '../dist/storage/runs.js';

const full = () =>
  Object.assign(new Error('active child limit'), {
    name: 'SubagentError',
    code: 'ACTIVATION_LIMIT_REACHED',
  });
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sihq-admission-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const stateOf = (file) => JSON.parse(readFileSync(file, 'utf8')).state;

test('a capacity deadline leaves a resumable receipt, but unknown admission preserves uncertainty', async (t) => {
  const receiptFile = join(temporary(t), 'receipt.json');
  const request = { signal: new AbortController().signal, parent: { id: 'test' } };
  let attempts = 0;
  const service = {
    startActivation() {
      attempts++;
      throw full();
    },
  };
  await assert.rejects(
    startWithCapacity({ service, request, receiptFile, timeoutMs: 15 }),
    /尚未派发/,
  );
  const admissionAttempts = attempts;
  assert.ok(admissionAttempts >= 1);
  assert.equal(stateOf(receiptFile), 'waiting_capacity');
  const unknown = Object.assign(new Error('remote provider status unknown'), {
    code: 'ACTIVATION_LIMIT_REACHED',
  });
  service.startActivation = () => {
    attempts++;
    throw unknown;
  };
  await assert.rejects(startWithCapacity({ service, request, receiptFile }), (e) => e === unknown);
  assert.equal(attempts, admissionAttempts + 1);
  assert.equal(stateOf(receiptFile), 'submitting');
});

function graph(t, ids, activate, { services = {}, stepOptions = {} } = {}) {
  const root = temporary(t),
    cwd = join(root, 'workspace');
  mkdirSync(cwd);
  const flows = new WorkflowStore(join(root, 'flows')),
    runs = new RunStore(join(root, 'runs'));
  const parent = { id: 'parent', session: { header: { cwd } } };
  const listeners = new Set(),
    progress = [],
    logs = [];
  let work, receipt;
  const service = {
    getProvider: () => ({ capabilities: { agentPreset: true, outputSchema: true } }),
    startActivation: activate,
  };
  const ctx = {
    on(name, fn) {
      assert.equal(name, 'subagent/end');
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    get(name) {
      if (services[name]) return services[name];
      if (name === 'agentPresets') return { resolve: async (id) => ({ id }) };
      if (name === 'subagents') return service;
      if (name === 'jobs')
        return {
          start(job) {
            work = job.run({
              append: (text) => logs.push(text),
              updateProgress: (text) => progress.push(text),
            });
            return 'mock-job';
          },
        };
    },
  };
  const config = {
    templates: [
      {
        id: 'fixture',
        name: 'fixture',
        steps: ids.map((id) => ({
          id,
          name: id,
          kind: 'read',
          backend: 'spawn',
          instructions: id,
          ...stepOptions,
          ...(ids.length > 1 && { parallelGroup: 'group' }),
        })),
      },
    ],
  };
  const controllers = new Set();
  return {
    submit(action) {
      const request =
        action === 'start'
          ? { action, template: 'fixture', prompt: 'task' }
          : { action, id: receipt.flowId };
      submitWorkflow(
        ctx,
        config,
        parent,
        request,
        {
          onStarted(value) {
            receipt = value;
          },
        },
        controllers,
        { runs, flows },
      );
      return work;
    },
    flow: () => flows.read(receipt.flowId),
    release: () => [...listeners].forEach((fn) => fn({ parentSessionId: parent.id })),
    receipt: (entry) =>
      stateOf(join(runs.directory(entry.runId), 'dsh-' + entry.executionId + '.json')),
    service,
    listeners,
    progress,
    logs,
  };
}
const answer = { stopReason: 'completed', structured: { summary: 'done', evidence: ['mock'] } };
const handle = (id, result = Promise.resolve(answer)) => ({ childId: id, result, dispose() {} });

test('a queued workflow rechecks the live DSH depth limit before admitting its agent', async (t) => {
  const refused = Promise.withResolvers();
  const requests = [];
  const f = graph(t, ['read'], (request) => {
    requests.push(request.maxDepth);
    if (requests.length === 1) {
      refused.resolve();
      throw full();
    }
    return handle('reader');
  });
  let maxDepth = 2;
  f.service.resolveMaxDepth = () => maxDepth;
  f.service.getProvider = () => ({
    capabilities: { agentPreset: true, outputSchema: true, depthLimit: true },
  });
  const job = f.submit('start');
  await refused.promise;
  maxDepth = 0;
  f.release();
  assert.equal((await job.done).status, 'failed');
  const entry = f.flow().steps[0];
  assert.match(entry.error, /上限 0/);
  assert.equal(f.receipt(entry), 'waiting_capacity');
  assert.deepEqual(requests, [2]);
  maxDepth = 1;
  assert.equal((await f.submit('resume').done).status, 'completed');
  assert.deepEqual(requests, [2, 1]);
});

test('parallel readers share one DSH slot and a released slot wakes the waiting sibling', async (t) => {
  const first = Promise.withResolvers(),
    refused = Promise.withResolvers();
  let occupied = false;
  const accepted = [];
  const f = graph(t, ['left', 'right'], (req) => {
    if (occupied) {
      refused.resolve();
      throw full();
    }
    occupied = true;
    accepted.push(req.label);
    return handle(
      req.label,
      (req.label === 'left' ? first.promise : Promise.resolve(answer)).finally(() => {
        occupied = false;
        f.release();
      }),
    );
  });
  const job = f.submit('start');
  await refused.promise;
  const waiting = f.flow().steps.find((e) => e.node === 'right');
  assert.equal(waiting.waitingForCapacity, true);
  assert.equal(f.receipt(waiting), 'waiting_capacity');
  assert.ok(f.progress.some((text) => text.includes('等待 DSH 子 Agent 名额')));
  first.resolve(answer);
  assert.equal((await job.done).status, 'completed');
  assert.deepEqual(accepted, ['left', 'right']);
  assert.equal(f.listeners.size, 0);
  assert.equal(
    f.flow().steps.some((entry) => entry.waitingForCapacity),
    false,
  );
});

test('cancelled capacity wait can resume normally; failed child result requires explicit retry', async (t) => {
  const refused = Promise.withResolvers();
  let mode = 'full',
    accepted = 0;
  const f = graph(t, ['read'], () => {
    if (mode === 'full') {
      refused.resolve();
      throw full();
    }
    accepted++;
    return handle('reader', mode === 'lost' ? Promise.reject(full()) : Promise.resolve(answer));
  });
  const job = f.submit('start');
  await refused.promise;
  job.cancel('test cancellation');
  assert.equal((await job.done).status, 'killed');
  assert.equal(f.receipt(f.flow().steps[0]), 'waiting_capacity');
  assert.equal(f.listeners.size, 0);
  mode = 'lost';
  assert.equal((await f.submit('resume').done).status, 'failed');
  assert.equal(f.receipt(f.flow().steps[0]), 'submitted');
  assert.equal(accepted, 1);
  mode = 'available';
  assert.equal((await f.submit('resume').done).status, 'failed');
  assert.equal(accepted, 1);
  assert.equal((await f.submit('retry').done).status, 'completed');
  assert.equal(accepted, 2);
});

test('queued requests validate the exact model sent after a slot becomes available', async (t) => {
  const fullOnce = Promise.withResolvers();
  let model = 'initial';
  const checked = [],
    sent = [];
  const llm = {
    listProviders: () => [{ id: 'p' }],
    resolveCallConfig({ model }) {
      checked.push(model);
      if (model === 'removed') throw Error('removed');
    },
  };
  const f = graph(
    t,
    ['r'],
    (spec) => {
      sent.push(spec.agentOptions.model);
      if (sent.length === 1) {
        fullOnce.resolve();
        throw full();
      }
      return handle('r');
    },
    { services: { llm }, stepOptions: { reasoningEffort: 'high' } },
  );
  f.service.getProvider = () => ({
    capabilities: { agentOptions: true, agentPreset: true, outputSchema: true },
    agentRouteDefaults: { provider: 'p', model },
  });
  const job = f.submit('start');
  await fullOnce.promise;
  model = 'removed';
  f.release();
  assert.equal((await job.done).status, 'failed');
  assert.deepEqual(sent, ['initial']);
  assert.deepEqual(checked, ['initial', 'removed']);
  assert.equal(f.receipt(f.flow().steps[0]), 'waiting_capacity');
  model = 'fixed';
  assert.equal((await f.submit('resume').done).status, 'completed');
  assert.deepEqual(sent, ['initial', 'fixed']);
});

test('queue deadline also interrupts a slow route lookup without another submission', async (t) => {
  const receiptFile = join(temporary(t), 'receipt.json'),
    gate = Promise.withResolvers();
  let lookups = 0,
    submissions = 0;
  const work = startWithCapacity({
    request: { parent: { id: 's' }, signal: new AbortController().signal },
    receiptFile,
    timeoutMs: 100,
    ctx: {
      on(_, wake) {
        queueMicrotask(() => wake({ parentSessionId: 's' }));
        return () => {};
      },
    },
    async prepare(request) {
      if (++lookups === 2) await gate.promise;
      return request;
    },
    service: {
      startActivation() {
        submissions++;
        throw full();
      },
    },
  });
  let lookupFinished = false;
  const timer = setTimeout(() => {
    lookupFinished = true;
    gate.resolve();
  }, 2000);
  try {
    await assert.rejects(work, /尚未派发/);
    assert.equal(lookups, 2);
    assert.equal(submissions, 1);
    assert.equal(stateOf(receiptFile), 'waiting_capacity');
    assert.equal(lookupFinished, false);
  } finally {
    clearTimeout(timer);
    gate.resolve();
  }
});
