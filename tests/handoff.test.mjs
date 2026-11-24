import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { apply } from '../plugin.js';
import { WorkflowStore } from '../dist/storage/workflows.js';
import { projectDocuments } from '../project-documents.js';
import { attachDiff, selectHandoff } from '../workflow-handoff.js';
import { stepDiff } from '../workflow-git.js';

test('project references freeze selected Markdown and confine reads to the effective workspace', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'project-docs-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cwd = join(dir, 'project'),
    outside = join(dir, 'other');
  mkdirSync(cwd);
  mkdirSync(outside);
  writeFileSync(join(cwd, 'rules.md'), 'first');
  writeFileSync(join(outside, 'other.md'), 'outside');
  symlinkSync(outside, join(cwd, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  let calls = 0;
  const files = {
    readBytes(scope, path) {
      assert.equal(scope.workspaceRoot, cwd);
      calls++;
      return { eof: true, absolutePath: path, data: readFileSync(path) };
    },
  };
  const trial = { cwd };
  const load = (file) =>
    projectDocuments(
      { get: () => files },
      { id: 'a' },
      trial,
      { file },
      new AbortController().signal,
    );
  const { item } = await load('rules.md');
  writeFileSync(join(cwd, 'rules.md'), 'second');
  const { item: later } = await load('rules.md');
  assert.notEqual(later.id, item.id);
  assert.deepEqual(selectHandoff(trial, JSON.stringify([item.id])), [item]);
  assert.equal(item.text, 'first');
  assert.deepEqual(selectHandoff(trial, '[]'), []);
  assert.throws(() => selectHandoff({ cwd }, JSON.stringify([item.id])));
  await assert.rejects(load('../other/other.md'), /工作目录/);
  await assert.rejects(load('linked/other.md'), /工作目录/);
  await assert.rejects(load('rules.js'), /Markdown/);
  assert.equal(calls, 2);
});
test('retrying a failed Git reference freezes the first successful read', async () => {
  const trial = { cwd: 'project' };
  await attachDiff(trial, () => {
    throw new Error('temporarily unavailable');
  });
  assert.equal(trial.diffError, 'temporarily unavailable');
  await attachDiff(trial, () => 'confirmed snapshot');
  assert.equal(trial.diffError, undefined);
  await attachDiff(trial, () => 'later edit');
  assert.equal(JSON.parse(trial.diff.text), 'confirmed snapshot');
});

test('preview scopes and freezes chosen chat, report and diff across rounds and preserves the delivery trace', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-handoff-'));
  const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
  const previous = process.env[homeKey];
  process.env[homeKey] = root;
  t.after(() => {
    if (previous === undefined) delete process.env[homeKey];
    else process.env[homeKey] = previous;
    rmSync(root, { recursive: true, force: true });
  });
  assert.equal(homedir(), root);
  const cwd = join(root, 'project');
  mkdirSync(cwd);
  const git = (...args) => execFileSync('git', args, { cwd, windowsHide: true, stdio: 'pipe' });
  git('init');
  writeFileSync(join(cwd, 'file.txt'), 'before\n');
  git('add', 'file.txt');
  writeFileSync(join(cwd, 'file.txt'), 'previewdiff\n');
  const text = (value) => [{ type: 'text', text: value }];
  const human = (value) => ({
    type: 'user/message',
    data: { source: { kind: 'user' }, content: text(value) },
  });
  const events = [
    human('chosen chat'),
    human('NOT_SELECTED'),
    { type: 'user/message', data: { source: { kind: 'plugin' }, content: text('INTERNAL') } },
    {
      type: 'assistant/message',
      data: {
        message: { content: [{ type: 'thinking', text: 'HIDDEN' }, ...text('assistant answer')] },
      },
    },
  ];
  const agent = {
    id: 's1',
    session: {
      header: { cwd },
      snapshotEvents: () => events,
      append(type, data) {
        const seq = events.length;
        const event = { seq, type, data };
        events.push(event);
        return event;
      },
      eventAt: (seq) => events[seq],
    },
  };
  const requests = [];
  let duringStep;
  let command, done;
  const endpoints = new Map();
  const ctx = {
    commands: {
      register(value) {
        command = value;
      },
    },
    inject(keys, cb) {
      if (keys.includes('connection'))
        cb({
          connection: {
            fetch: {
              register(r) {
                endpoints.set(r.path, r);
              },
            },
          },
        });
    },
    get(name) {
      if (name === 'agentPresets') return { resolve: async (id) => ({ id }) };
      if (name === 'agents') return { get: (id) => (id === agent.id ? agent : undefined) };
      if (name === 'jobs')
        return {
          start(spec) {
            done = spec.run({ append() {}, updateProgress() {} }).done;
            return 'fake-job';
          },
        };
      if (name === 'subagents')
        return {
          getProvider: () => ({
            capabilities: { agentPreset: true, agentOptions: true, outputSchema: true },
          }),
          startActivation(spec) {
            requests.push(spec);
            duringStep?.(spec);
            return {
              childId: 'child-' + requests.length,
              result: Promise.resolve({
                stopReason: 'completed',
                structured: { summary: 'Report ' + requests.length, evidence: ['evidence'] },
              }),
              dispose() {},
            };
          },
        };
    },
  };
  const id = 'flow';
  apply(ctx, {
    templates: [
      {
        id,
        name: 'Fixture',
        steps: [{ id: 'r', name: 'Read', kind: 'read', backend: 'spawn', instructions: 'Review.' }],
      },
      {
        id: 'dual-diff',
        name: 'DualDiff',
        includeDiff: true,
        steps: [
          {
            id: 'first',
            name: 'before',
            kind: 'read',
            backend: 'spawn',
            instructions: 'Check baseline.',
          },
          {
            id: 'later',
            name: 'after',
            kind: 'read',
            backend: 'spawn',
            instructions: 'Check working tree.',
            currentDiff: true,
          },
        ],
      },
    ],
  });
  const rpc = async (method, payload) => {
    const path = '/api/sihqCatalog/' + method;
    const response = await endpoints.get(path).fetch(
      new Request('http://localhost' + path, {
        method: 'POST',
        body: JSON.stringify({ rpcId: 'test', payload: { sessionId: 's1', ...payload } }),
      }),
    );
    const result = (await response.json()).result;
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  };
  const launch = (plan, ids) =>
    command.handler({
      agent,
      rawInput: JSON.stringify(['launch', plan.token, 'current task', JSON.stringify(ids)]),
    });
  const plan = await rpc('prepareLaunch', { selected: id });
  await assert.rejects(rpc('contextSources', { token: plan.token, sessionId: 'other' }));
  const choices = await rpc('contextSources', { token: plan.token, includeDiff: true });
  assert.ok(!choices.items.some((i) => i.text.includes('HIDDEN') || i.text.includes('INTERNAL')));
  const selected = choices.items.find((i) => i.text === 'chosen chat');
  writeFileSync(join(cwd, 'file.txt'), 'LATER_DIFF\n');
  events[0] = human('LATER_EDIT');
  assert.equal((await launch(plan, ['invalid'])).kind, 'error');
  const accepted = await launch(plan, [selected.id, 'git-diff']);
  assert.equal(accepted.kind, 'success');
  const receipt = await rpc('commandReceipt', { seq: accepted.sourceEventSeq });
  assert.equal(receipt.jobId, 'fake-job');
  await assert.rejects(rpc('commandReceipt', { seq: accepted.sourceEventSeq, sessionId: 'other' }));
  await done;
  const store = new WorkflowStore();
  const flow = store.listPage(cwd, { session: 's1' }).items[0];
  assert.equal(flow.prompt, 'current task');
  const actual = requests[0].prompt[0].text;
  assert.match(actual, /chosen chat/);
  assert.match(actual, /previewdiff/);
  assert.doesNotMatch(actual, /NOT_SELECTED|LATER_|assistant answer/);
  const trace = await rpc('runStep', { id: flow.id, index: 0, round: 1 });
  assert.equal(trace.input.prompt, actual);
  assert.deepEqual(trace.input.outputSchema, requests[0].outputSchema);
  const next = await rpc('prepareContinuation', { id: flow.id });
  const stepReads = t.mock.method(WorkflowStore.prototype, 'readStep');
  const choices2 = await rpc('contextSources', { token: next.token, compact: true });
  const ref = choices2.items.find((i) => i.kind === 'report');
  assert.ok(choices2.items.every((item) => !('text' in item)));
  assert.equal(stepReads.mock.callCount(), 0);
  await assert.rejects(
    rpc('contextReference', { token: next.token, id: ref.id, sessionId: 'other' }),
  );
  const report = await rpc('contextReference', { token: next.token, id: ref.id });
  assert.deepEqual(await rpc('contextReference', { token: next.token, id: ref.id }), report);
  assert.equal(stepReads.mock.callCount(), 1);
  assert.match(report.text, /Report 1/);
  assert.equal((await launch(next, [report.id])).kind, 'success');
  await done;
  assert.match(requests[1].prompt[0].text, /Report 1/);
  assert.doesNotMatch(requests[1].prompt[0].text, /chosen chat|previewdiff/);
  assert.deepEqual(
    store.read(flow.id).dsh.handoff.map((s) => s.kind),
    ['report'],
  );
  assert.equal((await rpc('runStep', { id: flow.id, index: 0, round: 1 })).input.prompt, actual);

  await t.test(
    'menu, command and continuation freeze one round baseline and read the later step diff independently',
    async () => {
      let latestId;
      for (const mode of ['command', 'menu', 'continue']) {
        const before = 'baseline-' + mode;
        const after = 'after-first-' + mode;
        writeFileSync(join(cwd, 'file.txt'), before);
        const start = requests.length;
        duringStep = () => {
          if (requests.length === start + 1) writeFileSync(join(cwd, 'file.txt'), after);
        };
        const cmd =
          mode === 'menu'
            ? await launch(await rpc('prepareLaunch', { selected: 'dual-diff' }), [])
            : await command.handler({
                agent,
                rawInput:
                  mode === 'command'
                    ? 'run "DualDiff" "initial"'
                    : 'workflow continue ' + latestId + ' "follow-up"',
              });
        assert.equal(cmd.kind, 'success', cmd.text);
        assert.equal((await done).status, 'completed');
        latestId = store.listPage(cwd, { session: agent.id }).items[0].id;
        const state = store.read(latestId);
        assert.equal(JSON.parse(state.dsh.handoff[0].text).unstaged.includes(before), true);
        const [first, second] = requests.slice(start).map((req) => req.prompt[0].text);
        assert.ok(first.includes(before) && !first.includes(after));
        assert.ok(second.includes(before) && second.includes(after));
        const trace = await rpc('runStep', { id: latestId, round: state.round ?? 1, index: 1 });
        assert.equal(trace.input.prompt, second);
        assert.deepEqual(
          trace.input.sources.map((s) => s.id),
          ['git-step-diff', 'git-diff'],
        );
      }
      writeFileSync(join(cwd, 'file.txt'), 'retry-baseline');
      const start = requests.length;
      duringStep = () => {
        if (requests.length === start + 1)
          writeFileSync(join(cwd, 'file.txt'), 'first-attempt-only');
        if (requests.length === start + 2) throw new Error('simulated interrupted activation');
      };
      const send = (rawInput) => command.handler({ agent, rawInput });
      assert.equal((await send('run "DualDiff" "retry case"')).kind, 'success');
      assert.equal((await done).status, 'failed');
      const interruptedId = store.listPage(cwd, { session: agent.id }).items[0].id;
      const firstAttempt = (await rpc('runStep', { id: interruptedId, round: 1, index: 1 })).input
        .prompt;
      assert.ok(
        firstAttempt.includes('retry-baseline') && firstAttempt.includes('first-attempt-only'),
      );
      duringStep = undefined;
      writeFileSync(join(cwd, 'file.txt'), 'explicit-retry-only');
      const selection = async () =>
        (await rpc('runProgress', { id: interruptedId })).recovery.token;
      const oldToken = await selection();
      assert.equal(
        (await send('workflow resume ' + interruptedId + ' --if-current ' + oldToken)).kind,
        'success',
      );
      assert.equal((await done).status, 'failed');
      assert.equal(requests.length, start + 2);
      assert.equal(
        (await send('workflow retry ' + interruptedId + ' --if-current ' + oldToken)).kind,
        'error',
      );
      assert.equal(
        (await send('workflow retry ' + interruptedId + ' --if-current ' + (await selection())))
          .kind,
        'success',
      );
      assert.equal((await done).status, 'completed');
      const detail = await rpc('runStep', { id: interruptedId, round: 1, index: 1 });
      const replayed = detail.input;
      assert.ok(
        replayed.prompt.includes('retry-baseline') &&
          replayed.prompt.includes('explicit-retry-only'),
      );
      assert.equal(detail.previousAttempts[0].input.prompt, firstAttempt);
      const original = await stepDiff(cwd, root, 'resume-test', false);
      writeFileSync(join(cwd, 'file.txt'), 'edited-before-resume');
      assert.deepEqual(await stepDiff(cwd, root, 'resume-test', false), original);
      assert.match(
        (await stepDiff(cwd, root, 'resume-test', true)).unstaged,
        /edited-before-resume/,
      );
      writeFileSync(join(cwd, 'file.txt'), 'q'.repeat(3 * 1024 * 1024));
      const beforeOversized = requests.length;
      const denied = await command.handler({ agent, rawInput: 'run "DualDiff" "too large"' });
      assert.equal(denied.kind, 'error');
      assert.match(denied.text, /Git diff/);
      const refusedPreview = await rpc('prepareLaunch', { selected: 'dual-diff' });
      assert.equal(refusedPreview.flow.preflight.ok, false);
      assert.equal(requests.length, beforeOversized);
    },
  );
});

test('both Git collectors restrict status and diffs to a nested DSH workspace', async (t) => {
  const { captureGit } = await import('../dist/workspace/git.js');
  const { inspectTrackedDiff, trackedDiff } = await import('../workflow-git.js');
  const root = mkdtempSync(join(tmpdir(), 'sihq-nested-git-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true });
  git('init', '--quiet');
  for (const name of ['ui', 'api']) {
    mkdirSync(join(root, name));
    writeFileSync(join(root, name, 'file.txt'), 'initial\n');
  }
  git('add', '.');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.invalid',
    'commit',
    '-qm',
    'initial',
  );
  for (const name of ['ui', 'api']) writeFileSync(join(root, name, 'file.txt'), name + '-staged\n');
  git('add', '.');
  for (const name of ['ui', 'api'])
    writeFileSync(join(root, name, 'file.txt'), name + '-unstaged\n');
  const cwd = join(root, 'ui');
  const builtin = captureGit(cwd);
  for (const diff of [
    trackedDiff(cwd),
    await inspectTrackedDiff(cwd),
    { staged: builtin.stagedDiff, unstaged: builtin.diff },
  ]) {
    assert.match(diff.staged, /ui-staged/);
    assert.match(diff.unstaged, /ui-unstaged/);
    assert.doesNotMatch(JSON.stringify(diff), /api-/);
  }
  assert.doesNotMatch(builtin.status, /api/);
  assert.ok(builtin.files.every((f) => f.path.startsWith('ui/')));
  const { preflightWorkflow } = await import('../workflow-preflight.js');
  writeFileSync(join(cwd, 'file.txt'), 'q'.repeat(3 * 1024 * 1024));
  const ctx = {
    get: (k) =>
      k === 'jobs'
        ? {}
        : k === 'subagents'
          ? { getProvider: () => ({ capabilities: { agentOptions: true } }) }
          : undefined,
  };
  const step = { name: 'later', backend: 'custom', kind: 'develop', currentDiff: true };
  const inspect = (includeDiff) =>
    preflightWorkflow(ctx, { template: { steps: [step], includeDiff } }, cwd);
  assert.equal((await inspect(false)).ok, true);
  assert.equal((await inspect(true)).ok, false);
});
