import { checkRecoveryPages } from './recovery-model.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  appendFileSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { RunStore } from '../dist/storage/runs.js';
import { WorkflowStore } from '../dist/storage/workflows.js';
import { registerReadonlyCodex, submitWorkflow } from '../native.js';
import { describeRun, runStep } from '../run-results.js';

const plan = {
  goal: 'test',
  steps: [{ description: 'edit', files: ['a.txt'], validation: 'look' }],
  acceptanceCriteria: ['a'],
  risks: [],
};
const implementation = {
  summary: 'done',
  outcome: 'implemented',
  changes: [],
  validations: [],
  remaining: [],
};
function review(pass) {
  return {
    verdict: pass ? 'passed' : 'changes_requested',
    summary: 'review',
    criteria: [
      {
        criterion: 'a',
        result: pass ? 'passed' : 'failed',
        evidence: 'file contents',
      },
    ],
    findings: pass
      ? []
      : [
          {
            severity: 'high',
            location: 'a.txt',
            problem: 'missing',
            evidence: 'empty',
            requestedChange: 'write a',
          },
        ],
    checks: [],
    limitations: [],
  };
}
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sihq-native-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'repo');
  mkdirSync(cwd);
  writeFileSync(join(cwd, 'sihq.config.json'), 'invalid CLI configuration'); // DSH owns native role configuration.
  const flows = new WorkflowStore(join(dir, 'flows'));
  const runs = new RunStore(join(dir, 'runs'));
  const config = {
    planner: 'spawn',
    developer: 'claude-code',
    reviewer: 'sihq-codex-readonly',
    plannerModel: 'test-model',
    maxRepairs: 1,
  };
  const activations = [];
  const jobs = [];
  const logs = [];
  const control = { pass: false, breakDeveloper: false, hold: false };
  const service = {
    getProvider(name) {
      return ['spawn', 'claude-code', 'sihq-codex-readonly'].includes(name)
        ? {
            capabilities: {
              agentPreset: name === 'spawn',
              agentOptions: name === 'spawn',
              outputSchema: name === 'spawn',
            },
          }
        : undefined;
    },
    async startActivation(spec) {
      activations.push(spec);
      let value;
      const type = spec.label;
      if (type === 'developer' && control.fault) {
        control.entered.resolve();
        if (control.fault === 'beforeAdmission')
          throw Object.assign(Error('capacity'), {
            name: 'SubagentError',
            code: 'ACTIVATION_LIMIT_REACHED',
          });
        if (control.fault === 'missingReceipt') throw Error('admission acknowledgement lost');
        appendFileSync(join(cwd, 'edits.txt'), 'uncertain edit\n');
        return {
          childId: 'writer',
          result: Promise.reject(Error('result lost after edit')),
          dispose() {},
        };
      }
      if (control.failOnce?.delete(type)) throw Error('first attempt failed');
      if (type === 'left' || type === 'right') value = { summary: type, evidence: ['seen'] };
      if (
        type === 'developer' &&
        control.rejectRepair &&
        activations.filter((a) => a.label === type).length > 1
      )
        throw Error('before admission');
      if (type === 'developer' && control.diagnostic)
        return {
          childId: 'failed-child',
          result: Promise.resolve({
            stopReason: 'error',
            output: [],
            diagnostic: 'fixture provider rejected',
          }),
          dispose() {},
        };
      if (type === 'planner') value = plan;
      if (type === 'developer') {
        if (control.writeFile) appendFileSync(join(cwd, 'edits.txt'), 'edit\n');
        value = control.breakDeveloper ? {} : (control.implementation ?? implementation);
      }
      if (type === 'reviewer') {
        value = control.reviewWithoutDefect
          ? { ...review(true), verdict: 'changes_requested' }
          : review(control.pass);
        if (config.reviewPolicy === 'blocking') {
          value.suggestions = [
            {
              severity: 'P2',
              location: 'a.txt',
              problem: 'later',
              evidence: 'duplication',
              requestedChange: 'combine later',
            },
          ];
          value.findings = value.findings.map((f) => ({ ...f, severity: 'P1' }));
        }
        control.pass = true;
      }
      const result = spec.outputSchema
        ? { stopReason: 'completed', structured: value, output: [] }
        : {
            stopReason: 'completed',
            output: [
              {
                type: 'text',
                text: '\x60\x60\x60json\n' + JSON.stringify(value) + '\n\x60\x60\x60',
              },
            ],
          };
      let release;
      return {
        childId: 'child-' + activations.length,
        result:
          control.hold || control.holdLabel === type
            ? new Promise((r) => {
                release = r;
              })
            : Promise.resolve(result),
        dispose() {
          release?.({ stopReason: 'aborted', output: [] });
        },
      };
    },
  };
  const parent = { id: 'session-1', session: { header: { cwd } } };
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return { resolve: async (id) => ({ id }) };
      return name === 'subagents'
        ? service
        : {
            start(spec) {
              jobs.push(
                spec.run({
                  append: (text) => logs.push(text),
                  updateProgress(value) {
                    logs.push(value);
                  },
                }),
              );
              return 'job-' + jobs.length;
            },
          };
    },
  };
  const submit = (request, flags = {}) =>
    submitWorkflow(ctx, config, parent, request, flags, new Set(), {
      flows,
      runs,
    });
  return {
    flows,
    runs,
    submit,
    activations,
    jobs,
    logs,
    config,
    parent,
    control,
  };
}
test('native role routing, bounded repair and frozen configuration across rounds', async (t) => {
  const f = fixture(t);
  f.config.plannerReasoningEffort = 'test-effort';
  assert.match(f.submit({ action: 'start', prompt: 'make a' }).text, /job-1/);
  assert.equal((await f.jobs[0].done).status, 'completed', f.logs.join('\n'));
  assert.deepEqual(
    f.activations.map((x) => x.provider),
    ['spawn', 'claude-code', 'sihq-codex-readonly', 'claude-code', 'sihq-codex-readonly'],
  );
  assert.equal(f.activations[0].agentPreset, 'sihq-readonly');
  assert.equal(f.activations[0].agentOptions.model, 'test-model');
  assert.equal(f.activations[0].agentOptions.reasoningEffort, 'test-effort');
  assert.equal(f.activations[0].outputSchema.properties.goal.minLength, undefined);
  assert.ok(f.activations.every((x) => x.delivery === 'caller'));
  assert.match(f.activations[3].prompt[0].text, /missing/);
  const flow = f.flows.list()[0];
  assert.ok(f.activations.every((spec) => spec.cwd === flow.cwd));
  assert.equal(flow.repairCount, 1);
  f.config.developer = 'missing';
  f.submit({ action: 'continue', id: flow.id, prompt: 'new goal' });
  assert.equal((await f.jobs.at(-1).done).status, 'completed', f.logs.join('\n'));
  assert.equal(f.flows.read(flow.id).round, 2);
  f.parent.id = 'another-session';
  assert.throws(() => f.submit({ action: 'resume', id: flow.id }), /会话/);
});
test('built-in blocking policy repairs a P1 once and keeps P2 on a passed review', async (t) => {
  const f = fixture(t);
  f.config.reviewPolicy = 'blocking';
  f.submit({ action: 'start', prompt: 'priority review' });
  assert.equal((await f.jobs[0].done).status, 'completed', f.logs.join('\n'));
  const flow = f.flows.list()[0];
  assert.equal(flow.status, 'passed');
  assert.equal(flow.repairCount, 1);
  const reviews = flow.steps.filter((s) => s.stage === 'review');
  assert.equal(reviews[0].report.findings[0].severity, 'P1');
  assert.equal(reviews[1].report.suggestions[0].severity, 'P2');
  assert.match(f.activations.at(-1).prompt[0].text, /上次审查阻塞项/);
});
test('invalid external output fails validation and resume never replays a write implicitly', async (t) => {
  const f = fixture(t);
  f.control.breakDeveloper = true;
  f.submit({ action: 'start', prompt: 'make a' });
  assert.equal((await f.jobs[0].done).status, 'failed');
  const flow = f.flows.list()[0];
  assert.equal(f.activations.length, 2);
  f.control.breakDeveloper = false;
  f.submit({ action: 'resume', id: flow.id });
  assert.equal((await f.jobs.at(-1).done).status, 'failed');
  assert.equal(f.activations.length, 2);
  f.control.pass = true;
  f.submit({ action: 'retry', id: flow.id });
  assert.equal((await f.jobs.at(-1).done).status, 'completed', f.logs.join('\n'));
  assert.equal(f.activations.length, 4);
  const before = flow.steps[1];
  const updated = f.flows.read(flow.id).steps[1];
  assert.notEqual(updated.executionId, before.executionId);
  assert.equal(updated.previousAttempts[0].executionId, before.executionId);
  const receipt = JSON.parse(
    readFileSync(join(f.runs.directory(before.runId), 'dsh-' + before.executionId + '.json')),
  );
  assert.equal(receipt.answer, '{}');
  assert.equal(receipt.childId, 'child-2');
});
test('reassigning a failed built-in writer preserves its attempt and never dispatches the planner again', async (t) => {
  const f = fixture(t);
  f.config.agentInstances = [
    { id: 'replacement', name: 'Replacement', backend: 'spawn', model: 'new-model' },
  ];
  f.control.breakDeveloper = true;
  f.submit({ action: 'start', prompt: 'make a' });
  assert.equal((await f.jobs[0].done).status, 'failed');
  const flow = f.flows.list()[0];
  const attempt = flow.steps.at(-1);
  const request = {
    action: 'reassign',
    id: flow.id,
    executionId: attempt.executionId,
    instanceId: 'replacement',
  };
  assert.throws(() => f.submit(request), /显式确认/);
  assert.throws(() => f.submit({ ...request, confirmed: true, revision: 'stale' }), /配置已变更/);
  f.config.agentInstances.push({ id: 'read-only', name: '只读', backend: 'sihq-codex-readonly' });
  assert.throws(() => f.submit({ ...request, confirmed: true, instanceId: 'read-only' }), /写权限/);
  assert.equal(f.activations.length, 2);
  f.control.breakDeveloper = false;
  f.control.pass = true;
  f.submit({ ...request, confirmed: true });
  assert.equal((await f.jobs.at(-1).done).status, 'completed', f.logs.join('\n'));
  assert.deepEqual(
    f.activations.map((x) => x.label),
    ['planner', 'developer', 'developer', 'reviewer'],
  );
  assert.equal(f.activations[2].agentOptions.model, 'new-model');
  const saved = f.flows.read(flow.id);
  const updated = saved.steps[1];
  assert.notEqual(updated.executionId, attempt.executionId);
  assert.equal(updated.previousAttempts[0].route.backend, 'claude-code');
  assert.equal(updated.previousAttempts[0].executionId, attempt.executionId);
  assert.equal(saved.dsh.roles.developer.backend, 'claude-code');
  const oldReceipt = JSON.parse(
    readFileSync(join(f.runs.directory(attempt.runId), 'dsh-' + attempt.executionId + '.json')),
  );
  assert.equal(oldReceipt.state, 'answered');
  const ctx = { get: (key) => (key === 'agents' ? { get: () => f.parent } : undefined) };
  const detail = await runStep(
    ctx,
    { sessionId: f.parent.id, id: flow.id, round: 1, index: 1 },
    f.flows,
    f.runs,
  );
  assert.equal(detail.instanceName, 'Replacement');
  assert.match(detail.previousAttempts[0].input.prompt, /JSON Schema/);
  assert.equal(detail.previousAttempts[0].answer, '{}');
  assert.equal(detail.previousAttempts[0].childId, oldReceipt.childId);
  assert.throws(() => f.submit({ ...request, confirmed: true }), /已变更/);
});
test('cancel disposes the active child, rejects unsafe roles and missing providers before starting', async (t) => {
  const f = fixture(t);
  f.config.reviewer = 'claude-code';
  assert.throws(() => f.submit({ action: 'start', prompt: 'a' }), /只读/);
  f.config.reviewer = 'missing';
  assert.throws(() => f.submit({ action: 'start', prompt: 'a' }), /未注册/);
  f.config.reviewer = 'spawn';
  f.config.developer = 'sihq-codex-readonly';
  assert.throws(() => f.submit({ action: 'start', prompt: 'a' }), /开发步骤需要工作区写权限/);
  f.config.developer = 'claude-code';
  f.config.feedback = 'missing';
  assert.throws(() => f.submit({ action: 'start', prompt: 'a' }), /未注册/);
  assert.equal(f.jobs.length, 0);
  f.config.feedback = 'spawn';
  f.control.hold = true;
  f.submit({ action: 'start', prompt: 'a' });
  await new Promise((resolve) => setImmediate(resolve));
  f.jobs[0].cancel('test');
  assert.equal((await f.jobs[0].done).status, 'killed');
  assert.equal(f.flows.list()[0].status, 'cancelled');
});

test('DSH failure diagnostics reach Jobs and uncertain writes require an explicit retry', async (t) => {
  const f = fixture(t);
  f.control.diagnostic = true;
  f.submit({ action: 'start', prompt: 'a' });
  const failed = await f.jobs[0].done;
  assert.equal(failed.status, 'failed');
  assert.match(failed.detail, /fixture provider rejected/);
  const flow = f.flows.list()[0];
  f.control.diagnostic = false;
  f.submit({ action: 'resume', id: flow.id });
  assert.match((await f.jobs.at(-1).done).detail, /workflow retry/);
  assert.equal(f.activations.length, 2);
  f.control.pass = true;
  f.submit({ action: 'retry', id: flow.id });
  assert.equal((await f.jobs.at(-1).done).status, 'completed');
});

test(
  'standalone Codex retains its read-only sandbox outside the registered Windows app',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const previous = process.env.CODEX_WINDOWS_REGISTERED_CORE;
    process.env.CODEX_WINDOWS_REGISTERED_CORE = '1';
    t.after(() => {
      if (previous === undefined) delete process.env.CODEX_WINDOWS_REGISTERED_CORE;
      else process.env.CODEX_WINDOWS_REGISTERED_CORE = previous;
    });
    let provider;
    let launch;
    const sentinel = new Error('captured spawn');
    registerReadonlyCodex({
      subagents: {
        registerProvider(value) {
          provider = value;
        },
      },
      subprocess: {
        resolveExecutable: async () => 'C:/test/codex.exe',
        spawn(spec) {
          launch = spec;
          throw sentinel;
        },
      },
    });
    await assert.rejects(
      provider.start({
        cwd: process.cwd(),
        prompt: [{ type: 'text', text: 'review' }],
        agentOptions: { model: 'review-model', reasoningEffort: 'high' },
        signal: new AbortController().signal,
      }),
      sentinel,
    );
    assert.ok(launch.argv.includes('--model=review-model'));
    assert.ok(launch.argv.includes('model_reasoning_effort="high"'));
    assert.equal(launch.env.CODEX_WINDOWS_REGISTERED_CORE, '0');
    assert.equal(launch.argv[launch.argv.indexOf('--sandbox') + 1], 'read-only');
    assert.equal(process.env.CODEX_WINDOWS_REGISTERED_CORE, '1');
  },
);

test('saved templates execute only selected nodes, route repairs and freeze their settings', async (t) => {
  const f = fixture(t);
  const node = (id, kind, backend, inputs = []) => ({
    id,
    kind,
    name: id,
    instructions: id,
    backend,
    inputs,
  });
  f.config.templates = [
    {
      id: 'cycle',
      name: 'cycle',
      steps: [
        node('developer', 'develop', 'claude-code'),
        {
          ...node('reviewer', 'review', 'spawn', ['developer']),
          returnTo: 'developer',
          maxRepairs: 1,
        },
      ],
    },
  ];
  f.config.templates[0].steps[1].reasoningEffort = 'high';
  f.config.selectedTemplate = 'cycle';
  f.submit({ action: 'start', prompt: 'a' });
  assert.equal((await f.jobs.at(-1).done).status, 'completed', f.logs.join('\n'));
  const flow = f.flows.list()[0];
  assert.deepEqual(
    flow.steps.map((e) => [e.node, e.provider]),
    [
      ['developer', 'claude-code'],
      ['reviewer', 'spawn'],
      ['developer', 'claude-code'],
      ['reviewer', 'spawn'],
    ],
  );
  assert.match(f.activations[2].prompt[0].text, /独立审查退回意见/);
  assert.match(f.activations[1].prompt[0].text, /implemented/);
  assert.equal(f.activations[1].agentOptions.reasoningEffort, 'high');
  f.config.templates = [];
  f.submit({ action: 'continue', id: flow.id, prompt: 'a' });
  assert.equal((await f.jobs.at(-1).done).status, 'completed');
  assert.equal(f.flows.read(flow.id).round, 2);
  assert.equal(f.activations.at(-1).agentOptions.reasoningEffort, 'high');
});
test('a review-only template returns findings without dispatching a developer', async (t) => {
  const f = fixture(t);
  f.config.templates = [
    {
      id: 'only',
      name: 'only',
      steps: [
        {
          id: 'r',
          kind: 'review',
          name: 'reviewer',
          instructions: 'read',
          backend: 'spawn',
        },
      ],
    },
  ];
  f.submit({ action: 'start', template: 'only', prompt: 'a' });
  assert.equal((await f.jobs[0].done).status, 'failed');
  assert.equal(f.flows.list()[0].status, 'changes_requested');
  assert.equal(f.activations.length, 1);
  assert.equal(f.activations[0].agentPreset, 'sihq-readonly');
});

test('built-in and custom reviews reject an unsupported change request without scheduling a repair', async (t) => {
  for (const template of [undefined, 'only']) {
    const f = fixture(t);
    f.control.reviewWithoutDefect = true;
    f.config.templates = [
      {
        id: 'only',
        name: 'only',
        steps: [
          { id: 'r', name: 'reviewer', kind: 'review', instructions: 'Review.', backend: 'spawn' },
        ],
      },
    ];
    f.submit({ action: 'start', template, prompt: 'a' });
    assert.equal((await f.jobs[0].done).status, 'failed');
    const flow = f.flows.list()[0];
    assert.match(flow.error, /未给出具体缺陷/);
    assert.equal(flow.repairCount, 0);
    assert.equal(
      f.activations.filter((activation) => activation.label === 'developer').length,
      template ? 0 : 1,
    );
  }
});

test('a missing required Git baseline blocks submission before creating a job', (t) => {
  const f = fixture(t);
  f.config.templates = [
    {
      id: 'diff',
      name: 'diff',
      includeDiff: true,
      steps: [
        {
          id: 'r',
          name: 'reviewer',
          kind: 'review',
          instructions: 'inspect',
          backend: 'spawn',
        },
      ],
    },
  ];
  assert.throws(() => f.submit({ action: 'start', template: 'diff', prompt: 'a' }), /Git diff/);
  assert.equal(f.jobs.length, 0);
  assert.equal(f.activations.length, 0);
});

test('zero repair budget stops at the first failed review', async (t) => {
  const f = fixture(t);
  f.config.templates = [
    {
      id: 'limited',
      name: 'limited',
      steps: [
        {
          id: 'd',
          name: 'developer',
          kind: 'develop',
          instructions: 'implement',
          backend: 'claude-code',
        },
        {
          id: 'r',
          name: 'reviewer',
          kind: 'review',
          instructions: 'inspect',
          backend: 'spawn',
          inputs: ['d'],
          returnTo: 'd',
          maxRepairs: 0,
        },
      ],
    },
  ];
  f.submit({ action: 'start', template: 'limited', prompt: 'a' });
  await f.jobs[0].done;
  const flow = f.flows.list()[0];
  assert.equal(flow.status, 'repair_limit_reached');
  assert.equal(flow.repairCount, 0);
  assert.deepEqual(
    flow.steps.map((step) => step.node),
    ['d', 'r'],
  );
});

test('cancelling a template review preserves the completed write and its original provider', async (t) => {
  const f = fixture(t);
  const template = {
    id: 'cancel',
    name: 'cancel',
    steps: [
      {
        id: 'd',
        name: 'developer',
        kind: 'develop',
        instructions: 'implement',
        backend: 'claude-code',
      },
      {
        id: 'r',
        name: 'reviewer',
        kind: 'review',
        instructions: 'inspect',
        backend: 'spawn',
        inputs: ['d'],
      },
    ],
  };
  f.config.templates = [template];
  f.control.writeFile = true;
  f.control.pass = true;
  f.control.holdLabel = 'reviewer';
  f.submit({ action: 'start', template: 'cancel', prompt: 'a' });
  while (f.activations.length < 2) await new Promise((resolve) => setTimeout(resolve, 5));
  f.jobs[0].cancel('test');
  assert.equal((await f.jobs[0].done).status, 'killed');
  const flow = f.flows.list()[0];
  template.steps[1].backend = 'sihq-codex-readonly';
  f.control.holdLabel = undefined;
  f.submit({ action: 'resume', id: flow.id });
  assert.equal((await f.jobs.at(-1).done).status, 'failed');
  f.submit({ action: 'retry', id: flow.id });
  assert.equal((await f.jobs.at(-1).done).status, 'completed');
  assert.deepEqual(
    f.activations.map((a) => a.provider),
    ['claude-code', 'spawn', 'spawn'],
  );
  assert.equal(readFileSync(join(flow.cwd, 'edits.txt'), 'utf8'), 'edit\n');
  assert.equal(f.flows.read(flow.id).status, 'passed');
  f.submit({ action: 'start', template: 'cancel', prompt: 'a' });
  assert.equal((await f.jobs.at(-1).done).status, 'completed');
  assert.equal(f.activations.at(-1).provider, 'sihq-codex-readonly');
});

test('a named instance resolves at launch and remains frozen through continuation', async (t) => {
  const f = fixture(t);
  f.config.agentInstances = [
    {
      id: 'reviewer',
      name: 'Review',
      backend: 'spawn',
      provider: 'fixture',
      model: 'review-model',
      reasoningEffort: 'high',
    },
  ];
  f.config.templates = [
    {
      id: 'named',
      name: 'Named',
      steps: [
        {
          id: 'reviewer',
          name: 'reviewer',
          kind: 'review',
          instructions: 'return evidence',
          backend: 'sihq-agent:reviewer',
          inputs: [],
        },
      ],
    },
  ];
  f.control.pass = true;
  f.submit({ action: 'start', template: 'named', prompt: 'a' });
  assert.equal((await f.jobs.at(-1).done).status, 'completed', f.logs.join('\n'));
  const flow = f.flows.list()[0];
  assert.equal(flow.dsh.template.steps[0].backend, 'spawn');
  assert.equal(flow.dsh.template.steps[0].instanceName, 'Review');
  f.config.agentInstances = [];
  f.submit({ action: 'continue', id: flow.id, prompt: 'a' });
  assert.equal((await f.jobs.at(-1).done).status, 'completed', f.logs.join('\n'));
  assert.deepEqual(f.activations.at(-1).agentOptions, {
    provider: 'fixture',
    model: 'review-model',
    reasoningEffort: 'high',
  });
  assert.throws(
    () => f.submit({ action: 'start', template: 'named', prompt: 'a' }),
    /找不到.*Agent 实例/,
  );
});

test('built-in roles receive explicit round attachments and a fresh selection on continuation', async (t) => {
  const f = fixture(t);
  f.control.pass = true;
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const previous = process.env[homeKey];
  process.env[homeKey] = f.parent.session.header.cwd;
  t.after(() => {
    if (previous === undefined) delete process.env[homeKey];
    else process.env[homeKey] = previous;
  });
  const source = { id: 'chat-ref', kind: 'chat', label: '用户', text: 'SELECTED_CONTEXT_ROUND_1' };
  f.submit({ action: 'start', prompt: 'base', handoff: [source] });
  assert.equal((await f.jobs[0].done).status, 'completed', f.logs.join('\n'));
  const flow = f.flows.list()[0];
  for (const request of f.activations)
    assert.match(request.prompt[0].text, /SELECTED_CONTEXT_ROUND_1/);
  const offset = f.activations.length;
  f.submit({ action: 'continue', id: flow.id, expectedRound: 1, prompt: 'next', handoff: [] });
  assert.equal((await f.jobs[1].done).status, 'completed', f.logs.join('\n'));
  const updated = f.flows.read(flow.id);
  assert.deepEqual(updated.dsh.handoff, []);
  assert.equal(updated.rounds[0].dsh.handoff[0].text, source.text);
  assert.equal(updated.previousRoleRunIds, undefined);
  for (const request of f.activations.slice(offset))
    assert.doesNotMatch(request.prompt[0].text, /SELECTED_CONTEXT_ROUND_1/);
  const start = f.activations.length;
  f.submit({ action: 'continue', id: flow.id, prompt: 'third', inheritReports: true });
  assert.equal((await f.jobs.at(-1).done).status, 'completed', f.logs.join('\n'));
  assert.ok(f.flows.read(flow.id).previousRoleRunIds.planner);
  assert.match(f.activations[start].prompt[0].text, /上次阶段报告/);
});

test('incomplete implementation survives a passing independent review in both engines', async (t) => {
  for (const template of [undefined, 'derived']) {
    const f = fixture(t);
    f.control.pass = true;
    f.control.implementation = {
      ...implementation,
      outcome: 'incomplete',
      remaining: ['finish migration'],
    };
    f.config.templates = [
      {
        id: 'derived',
        name: 'Derived',
        steps: ['planner', 'developer', 'reviewer'].map((name, index) => ({
          id: name,
          name,
          kind: ['plan', 'develop', 'review'][index],
          backend: f.config[name],
          instructions: name,
          inputs: index === 2 ? ['planner', 'developer'] : [],
        })),
      },
    ];
    f.submit({ action: 'start', template, prompt: 'a' });
    await f.jobs.at(-1).done;
    const flow = f.flows.list()[0];
    assert.equal(flow.status, 'incomplete');
    assert.match(flow.error, /finish migration/);
    f.submit({ action: 'continue', id: flow.id, prompt: 'a' });
    await f.jobs.at(-1).done;
    assert.equal(f.flows.read(flow.id).round, 2);
  }
});
test('native repair budget is charged once after DSH admits the repair', async (t) => {
  const f = fixture(t);
  f.control.rejectRepair = true;
  f.submit({ action: 'start', prompt: 'a' });
  await f.jobs[0].done;
  const flow = f.flows.list()[0];
  assert.equal(flow.status, 'failed');
  assert.equal(flow.repairCount, 0);
  const detail = describeRun(flow);
  assert.deepEqual(detail.recovery.attempts, [
    { executionId: flow.steps.at(-1).executionId, name: '修复' },
  ]);
  f.control.rejectRepair = false;
  f.submit({ action: 'retry', id: flow.id });
  await f.jobs.at(-1).done;
  assert.equal(f.flows.read(flow.id).repairCount, 1);
});
test('parallel Jobs progress identifies the dispatched step and run together', async (t) => {
  const f = fixture(t);
  f.config.templates = [
    {
      id: 'parallel',
      name: 'parallel',
      steps: ['left', 'right'].map((name) => ({
        id: name,
        name,
        kind: 'read',
        backend: 'spawn',
        instructions: 'read',
        parallelGroup: 'both',
      })),
    },
  ];
  f.submit({ action: 'start', template: 'parallel', prompt: 'a' });
  await f.jobs[0].done;
  for (const step of f.flows.list()[0].steps)
    assert.ok(f.logs.includes(step.node + ' · spawn · ' + step.runId));
});

test('second-round repair uses the local implementation receipt and a terminal resume creates no job', async (t) => {
  const f = fixture(t);
  f.control.pass = true;
  f.control.implementation = { ...implementation, summary: 'first-round-only' };
  f.submit({ action: 'start', prompt: 'first' });
  await f.jobs[0].done;
  const id = f.flows.list()[0].id;
  const start = f.activations.length;
  f.control.implementation = { ...implementation, summary: 'current-round-only' };
  f.control.pass = false;
  f.submit({ action: 'continue', id, inheritReports: true, prompt: 'second' });
  assert.equal((await f.jobs[1].done).status, 'completed');
  const writers = f.activations.slice(start).filter((a) => a.label === 'developer');
  assert.match(writers[0].prompt[0].text, /first-round-only/);
  assert.match(writers[1].prompt[0].text, /本轮被退回的开发报告[\s\S]*current-round-only/);
  assert.doesNotMatch(writers[1].prompt[0].text, /first-round-only/);
  const flow = f.flows.read(id);
  const entry = flow.steps.find((s) => s.stage === 'repair');
  const trace = JSON.parse(
    readFileSync(join(f.runs.directory(entry.runId), 'dsh-input-' + entry.executionId + '.json')),
  );
  assert.equal(
    trace.sources.find((r) => r.label === '本轮被退回的开发报告').id,
    flow.steps.find((s) => s.stage === 'implement').executionId,
  );
  assert.throws(() => f.submit({ action: 'resume', id }), /不能恢复/);
  assert.equal(f.jobs.length, 2);
  assert.deepEqual(f.flows.read(id), flow);
});

test('built-in retry obeys the attempt displayed on each page', async (t) => {
  await checkRecoveryPages(async () => {
    const f = fixture(t);
    f.control.failOnce = new Set(['planner', 'developer']);
    f.control.pass = true;
    f.submit({ action: 'start', prompt: 'test' });
    await f.jobs.at(-1).done;
    const id = f.flows.list()[0].id;
    return {
      read: () => f.flows.read(id),
      callCount: () => f.activations.length,
      async recover(action, expectedState) {
        f.submit({ action, id, expectedState });
        await f.jobs.at(-1).done;
      },
    };
  });
});

for (const engine of ['builtin', 'template']) {
  for (const phase of ['beforeAdmission', 'missingReceipt', 'afterWrite']) {
    test(engine + ' recovers conservatively at ' + phase, async (t) => {
      const f = fixture(t);
      f.config.templates = [
        {
          id: 'writer',
          name: 'writer',
          steps: [
            {
              id: 'developer',
              name: 'developer',
              kind: 'develop',
              backend: 'claude-code',
              instructions: 'edit',
            },
          ],
        },
      ];
      f.control.fault = phase;
      f.control.entered = Promise.withResolvers();
      f.control.pass = true;
      f.submit({
        action: 'start',
        prompt: 'edit',
        ...(engine === 'template' && { template: 'writer' }),
      });
      const first = f.jobs.at(-1);
      await f.control.entered.promise;
      if (phase === 'beforeAdmission') first.cancel('paused in queue');
      await first.done;
      const flow = f.flows.list()[0],
        entry = flow.steps.at(-1);
      const receipt = JSON.parse(
        readFileSync(
          join(f.runs.directory(entry.runId), 'dsh-' + entry.executionId + '.json'),
          'utf8',
        ),
      );
      assert.equal(
        receipt.state,
        {
          beforeAdmission: 'waiting_capacity',
          missingReceipt: 'submitting',
          afterWrite: 'submitted',
        }[phase],
      );
      f.control.fault = undefined;
      f.control.writeFile = true;
      const count = () => f.activations.filter((a) => a.label === 'developer').length;
      f.submit({ action: 'resume', id: flow.id });
      const resumed = await f.jobs.at(-1).done;
      if (phase === 'beforeAdmission') {
        assert.equal(resumed.status, 'completed');
      } else {
        assert.equal(resumed.status, 'failed');
        assert.equal(count(), 1);
        if (phase === 'afterWrite')
          assert.equal(readFileSync(join(flow.cwd, 'edits.txt'), 'utf8'), 'uncertain edit\n');
        f.submit({ action: 'retry', id: flow.id });
        assert.equal((await f.jobs.at(-1).done).status, 'completed');
      }
      assert.equal(count(), 2);
      assert.equal(
        readFileSync(join(flow.cwd, 'edits.txt'), 'utf8'),
        (phase === 'afterWrite' ? 'uncertain edit\n' : '') + 'edit\n',
      );
    });
  }
}
