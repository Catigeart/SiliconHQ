import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../dist/storage/runs.js';
import { WorkflowStore } from '../dist/storage/workflows.js';
import { workflowTemplateSchema } from '../workflow-templates.js';
import { lockWorkspace } from '../dist/storage/workspace-lock.js';
import { runTemplate } from '../template-runner.js';
import { stopVerificationJob } from '../verification-command.js';
import { describeRun } from '../run-results.js';
import { exportWorkflow, inspectImport, prepareImport } from '../workflow-portable.js';

const verification = { argv: ['node', 'check.js', 'two words', ''], timeoutMs: 10000 };
const gate = {
  id: 'test',
  name: '单测',
  kind: 'verify',
  instructions: '核对改动',
  backend: 'verification',
  verification,
};
const read = {
  id: 'report',
  name: '汇总',
  kind: 'read',
  instructions: '汇总测量值',
  backend: 'spawn',
  inputs: ['test'],
};
const template = { id: 'validation', name: 'Validation', steps: [gate, read] };

test('validates executable nodes and their portable argv without routing to a model', () => {
  const parsed = workflowTemplateSchema.parse(template);
  assert.deepEqual(parsed.steps[0].verification, verification);
  for (const invalid of [
    { ...gate, verification: undefined },
    { ...gate, verification: { ...verification, argv: [''] } },
    { ...gate, verification: { ...verification, timeoutMs: -1 } },
    { ...gate, backend: 'spawn' },
    { ...gate, model: 'unexpected' },
    { ...gate, parallelGroup: 'readers' },
    { ...read, verification },
  ])
    assert.equal(
      workflowTemplateSchema.safeParse({ ...template, steps: [invalid] }).success,
      false,
    );
});

test('command-only templates disclose the exact program on import and require no provider mapping', () => {
  const config = { templates: [{ ...template, steps: [gate] }] };
  const file = exportWorkflow(config, template.id);
  assert.deepEqual(file.instances, []);
  const preview = inspectImport(file, [], {});
  assert.deepEqual(preview.backends, []);
  assert.deepEqual(preview.verificationSteps, [{ name: gate.name, ...verification }]);
  const plan = prepareImport({}, file, [], []);
  const installed = plan.ops.find((op) => op.path[0] === 'templates').value.at(-1);
  assert.deepEqual(installed.steps[0].verification, verification);
  assert.equal(installed.steps[0].backend, 'verification');
});

test('a failed command stops the workflow; ordinary recovery never repeats it, and an explicit retry preserves both results', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-verify-gate-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const flows = new WorkflowStore(join(root, 'flows'));
  const runs = new RunStore(join(root, 'runs'));
  const frozen = { session: 's', template: workflowTemplateSchema.parse(template) };
  const observer = { onStage() {}, onUpdate() {}, onDispatch() {}, log() {} };
  let calls = 0;
  const downstream = [];
  const run = (request) =>
    runTemplate({
      cwd,
      flows,
      runs,
      frozen,
      request,
      observer,
      globalBudget: 0,
      signal: new AbortController().signal,
      async verify(command, directory) {
        calls++;
        assert.deepEqual(command, verification);
        assert.equal(directory, cwd);
        const exitCode = calls === 1 ? 7 : 0;
        return {
          cwd,
          argv: command.argv,
          exitCode,
          outcome: exitCode === 0 ? 'passed' : 'failed',
          summary: 'exit ' + exitCode,
          stdout: 'evidence-' + calls,
          stderr: '',
          durationMs: 2,
        };
      },
      async delegate(node, spec) {
        downstream.push(spec.prompt);
        return JSON.stringify({ summary: node.name, evidence: ['gate'] });
      },
    });
  const first = await run({ action: 'start', prompt: 'test' });
  const id = first.id;
  assert.equal(first.status, 'failed');
  assert.equal(first.steps[0].report.exitCode, 7);
  assert.equal(downstream.length, 0);
  assert.equal((await run({ action: 'resume', id })).status, 'failed');
  assert.equal(calls, 1);

  // The host may disappear between spawning the command and recording the exit code.
  const lost = flows.read(id);
  const savedReport = lost.steps[0].report;
  lost.status = 'running';
  lost.steps[0].status = 'running';
  delete lost.steps[0].report;
  flows.save(lost);
  const reconciled = await run({ action: 'resume', id });
  assert.equal(reconciled.status, 'failed');
  assert.match(reconciled.error, /显式重试/);
  assert.equal(calls, 1);
  reconciled.steps[0].report = savedReport;
  flows.save(reconciled);

  const successful = await run({ action: 'retry', id });
  assert.equal(successful.status, 'completed');
  assert.equal(calls, 2);
  assert.equal(downstream.length, 1);
  assert.match(downstream[0], /evidence-2/);
  assert.doesNotMatch(downstream[0], /evidence-1/);
  const detail = describeRun(flows.read(id), runs);
  assert.deepEqual(
    detail.steps.slice(0, 2).map((step) => step.report.exitCode),
    [7, 0],
  );
});

test('cancelling a promoted verification leaves its worktree locked until the host confirms termination', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'sihq-stopping-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const runs = new RunStore(join(cwd, 'runs')),
    flows = new WorkflowStore(join(cwd, 'flows'));
  const controller = new AbortController(),
    stopped = Promise.withResolvers();
  const flow = await runTemplate({
    cwd,
    flows,
    runs,
    frozen: {
      session: 's',
      template: workflowTemplateSchema.parse({ ...template, steps: [gate] }),
    },
    request: { action: 'start', prompt: 'verify' },
    globalBudget: 1,
    signal: controller.signal,
    observer: { onStage() {}, onUpdate() {}, log() {} },
    async verify(_cmd, _cwd, active, onStopping, waitForStop) {
      onStopping('shell-job');
      controller.abort();
      assert.equal(await waitForStop(stopped.promise, active), false);
      return { outcome: 'failed', commandFailed: false, summary: 'cancelled', jobId: 'shell-job' };
    },
  });
  try {
    assert.equal(flow.status, 'cancelled');
    assert.equal(flows.read(flow.id).steps[0].stoppingJobId, 'shell-job');
    assert.throws(() => lockWorkspace(cwd), /锁/);
  } finally {
    stopped.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(flows.read(flow.id).steps[0].stoppingJobId, undefined);
  lockWorkspace(cwd)();
});

test('verified nonzero exits can return to development and retest, or feed an explicit failure branch', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-verify-routing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const flows = new WorkflowStore(join(root, 'flows')),
    runs = new RunStore(join(root, 'runs'));
  const develop = {
    id: 'dev',
    name: '修复',
    kind: 'develop',
    instructions: '修复失败项',
    backend: 'writer',
  };
  async function exercise(steps, exits, budget = 1) {
    const calls = [],
      results = [...exits];
    const frozen = { session: 's', template: workflowTemplateSchema.parse({ ...template, steps }) };
    const flow = await runTemplate({
      cwd: root,
      flows,
      runs,
      frozen,
      globalBudget: budget,
      request: { action: 'start', prompt: '验证' },
      signal: new AbortController().signal,
      observer: { onStage() {}, onUpdate() {}, onDispatch() {}, log() {} },
      async verify() {
        const code = results.shift();
        assert.notEqual(code, undefined);
        return {
          exitCode: code,
          outcome: code === 0 ? 'passed' : 'failed',
          commandFailed: code === 7,
          stdout: 'stdout ' + code,
          stderr: 'stderr ' + code,
          summary: 'result ' + code,
        };
      },
      async delegate(node, spec) {
        calls.push(spec);
        return JSON.stringify(
          node.kind === 'develop'
            ? {
                summary: 'edit',
                outcome: 'implemented',
                changes: [],
                validations: [],
                remaining: [],
              }
            : { summary: 'explain', evidence: ['test report'] },
        );
      },
    });
    return { flow, calls };
  }
  const returning = [develop, { ...gate, returnTo: 'dev', maxRepairs: 1 }];
  const { flow, calls } = await exercise(returning, [7, 0]);
  assert.equal(flow.status, 'completed');
  assert.equal(flow.repairCount, 1);
  assert.deepEqual(
    flow.steps.map((s) => s.node),
    ['dev', 'test', 'dev', 'test'],
  );
  assert.match(calls[1].prompt, /验证失败报告[\s\S]*stderr 7/);
  assert.equal(calls[1].inputSources.find((s) => s.kind === 'feedback').id, flow.steps[1].runId);
  assert.equal((await exercise(returning, [7, 7])).flow.status, 'repair_limit_reached');
  assert.equal((await exercise(returning, [7], 0)).calls.length, 1);
  const unknown = await exercise(returning, [null]);
  assert.equal(unknown.flow.status, 'failed');
  assert.equal(unknown.flow.repairCount, 0);
  const branched = [gate, { ...read, when: { source: 'test', equals: 'failed' } }];
  const handled = await exercise(branched, [7]);
  assert.equal(handled.flow.status, 'completed');
  assert.match(handled.calls[0].prompt, /stderr 7/);
  assert.equal((await exercise(branched, [0])).calls.length, 0);
});

test('cancelling recovery of an old shell Job retains both locks until actual termination', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'sihq-recover-stop-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const flows = new WorkflowStore(join(cwd, 'flows')),
    runs = new RunStore(join(cwd, 'runs'));
  const base = {
    cwd,
    flows,
    runs,
    frozen: {
      session: 's',
      template: workflowTemplateSchema.parse({ ...template, steps: [gate] }),
    },
    globalBudget: 0,
    observer: { onStage() {}, onUpdate() {}, log() {} },
    async verify() {
      return { outcome: 'failed', summary: 'interrupted' };
    },
  };
  const old = await runTemplate({
    ...base,
    request: { action: 'start', prompt: 'verify' },
    signal: new AbortController().signal,
  });
  old.steps[0].stoppingJobId = 'prior-job';
  flows.save(old);
  const entered = Promise.withResolvers(),
    stopped = Promise.withResolvers(),
    controller = new AbortController();
  const work = runTemplate({
    ...base,
    request: { action: 'retry', id: old.id },
    signal: controller.signal,
    stopJob(id) {
      assert.equal(id, 'prior-job');
      entered.resolve();
      return stopped.promise;
    },
    verify() {
      assert.fail('old command is still stopping');
    },
  });
  await entered.promise;
  controller.abort();
  try {
    const state = await Promise.race([
      work.then(
        () => 'completed',
        (e) => e.name,
      ),
      new Promise((r) => setImmediate(() => r('pending'))),
    ]);
    assert.equal(state, 'AbortError');
    assert.equal(flows.read(old.id).steps[0].stoppingJobId, 'prior-job');
    assert.throws(() => flows.lock(old.id), /正在运行/);
    assert.throws(() => lockWorkspace(cwd), /锁/);
  } finally {
    stopped.resolve();
    await work.catch(() => {});
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(flows.read(old.id).steps[0].stoppingJobId, undefined);
  flows.lock(old.id)();
  lockWorkspace(cwd)();
});

test('an unconfirmed verifier fences other writers across a checkout change and recovery attempts', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-fenced-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.git'));
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const flows = new WorkflowStore(join(cwd, 'flows')),
    runs = new RunStore(join(cwd, 'runs'));
  const base = {
    cwd,
    flows,
    runs,
    globalBudget: 0,
    signal: new AbortController().signal,
    frozen: {
      session: 's',
      template: workflowTemplateSchema.parse({ ...template, steps: [gate] }),
    },
    observer: { onUpdate() {}, onStage() {}, log() {} },
  };
  let writes = 0;
  const start = { action: 'start', prompt: 'check' };
  const check = async () => {
    writes++;
    return { outcome: 'passed', exitCode: 0 };
  };
  const first = await runTemplate({
    ...base,
    request: start,
    async verify(v, c, s, stopping) {
      stopping('old-job');
      throw Error('cannot verify termination');
    },
  });
  assert.equal(first.status, 'failed');
  mkdirSync(join(cwd, '.git'));
  const retry = { action: 'retry', id: first.id };
  const stopped = {
    jobId: 'old-job',
    owner: 's',
    kind: process.platform === 'win32' ? 'pwsh' : 'bash',
    status: 'failed',
    cause: 'teardown',
    producerReported: false,
  };
  const parent = { id: 's', session: { events: [{ type: 'job/settled', data: stopped }] } };
  const ctx = { get: () => ({ kill: () => 'already-finished', wait() {} }) };
  await assert.rejects(
    runTemplate({
      ...base,
      request: retry,
      verify: check,
      stopJob: (id) => stopVerificationJob(ctx, parent, id),
    }),
    /等待确认/,
  );
  await assert.rejects(runTemplate({ ...base, request: start, verify: check }), /验证任务/);
  assert.throws(() => lockWorkspace(cwd), /验证任务/);
  assert.equal(writes, 0);
  const jobIds = [];
  Object.assign(stopped, { cause: 'kill', producerReported: true, status: 'killed' });
  const recovered = await runTemplate({
    ...base,
    request: retry,
    verify: check,
    async stopJob(id) {
      jobIds.push(id);
      await stopVerificationJob(ctx, parent, id);
    },
  });
  assert.deepEqual(jobIds, ['old-job']);
  assert.equal(recovered.status, 'completed');
  assert.equal(writes, 1);
  lockWorkspace(cwd)();
});
