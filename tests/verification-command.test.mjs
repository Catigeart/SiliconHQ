import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  stopVerificationJob,
  executeVerification,
  verifyCommandAvailable,
} from '../verification-command.js';

const parent = { id: 'test-session', session: {} };
const cwd = process.cwd();
const shell = process.platform === 'win32' ? 'pwsh' : 'bash';
const defaultCommand = { argv: ['node', '--version'], timeoutMs: 10_000 };
const freshSignal = () => new AbortController().signal;

function foreground(directory, changes = {}) {
  return {
    kind: 'foreground',
    cwd: directory,
    exitCode: 0,
    timedOut: false,
    aborted: false,
    signal: null,
    stdout: { text: '', truncated: false },
    stderr: { text: '', truncated: false },
    ...changes,
  };
}

function fixture(handle, services = {}) {
  let count = 0;
  const tools = {
    executable(name, owner) {
      return name === shell && owner === parent;
    },
    async execute(input) {
      count++;
      assert.equal(input.agent, parent);
      const [call] = input.calls;
      const result = await handle(JSON.parse(call.arguments), input.signal, call.name);
      return { results: [{ callId: call.id, result }] };
    },
  };
  return {
    get(name) {
      return { tools, ...services }[name];
    },
    calls: () => count,
  };
}

test('controlled verification preserves cwd, literal argv and a real process exit code', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'sihq verification '));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const specialArgs = ['space in value', 'a"b', "a'b", '‘q’', '', '$(1+1); & huh', '--flag'];
  const ctx = fixture(async (args, signal, name) => {
    assert.equal(name, shell);
    assert.equal(args.workdir, dir);
    let opts = ['-c', args.command];
    if (process.platform === 'win32') {
      // Compile the command in constrained language, just as the RC5 Windows
      // sandbox does. A single pre-parsed FullLanguage script wouldn't test this.
      await writeFile(join(dir, 'check.ps1'), args.command);
      opts = [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; & ./check.ps1; exit $LASTEXITCODE",
      ];
    }
    try {
      const { stdout } = await promisify(execFile)(name, opts, {
        cwd: args.workdir,
        windowsHide: true,
        signal,
      });
      return { isError: false, value: foreground(dir, { stdout: { text: stdout } }) };
    } catch (error) {
      if (error.code === 'ENOENT') throw error;
      return {
        isError: false,
        value: foreground(dir, {
          exitCode: error.code,
          stderr: { text: error.stderr },
          stdout: { text: error.stdout },
        }),
      };
    }
  });
  const notStarted = await executeVerification(
    ctx,
    parent,
    dir,
    { argv: ['sihq-missing-verifier-014'] },
    freshSignal(),
  );
  assert.equal(notStarted.outcome, 'failed');
  assert.equal(notStarted.commandFailed, false);
  assert.equal(notStarted.exitCode, null);
  const legitimate = await executeVerification(
    ctx,
    parent,
    dir,
    { argv: [process.execPath, '-e', 'process.exit(127)'] },
    freshSignal(),
  );
  assert.equal(legitimate.commandFailed, true);
  assert.equal(legitimate.exitCode, 127);
  const options = {
    argv: [
      process.execPath,
      '-e',
      'console.log(JSON.stringify(process.argv.slice(1))); process.exit(7)',
      '--',
      ...specialArgs,
    ],
  };
  const r = await executeVerification(ctx, parent, dir, options, freshSignal());
  assert.equal(r.exitCode, 7, JSON.stringify(r));
  assert.equal(r.commandFailed, true);
  assert.equal(r.outcome, 'failed');
  assert.deepEqual(JSON.parse(r.stdout), specialArgs);
  assert.equal(
    (await executeVerification(ctx, parent, dir, defaultCommand, freshSignal())).outcome,
    'passed',
  );
  if (process.platform === 'win32') {
    const find = join(dir, 'lookup[1].exe');
    await copyFile(join(process.env.SystemRoot, 'System32', 'where.exe'), find);
    const run = (argv) => executeVerification(ctx, parent, dir, { argv }, freshSignal());
    const found = await run([find, '/?']);
    assert.equal(found.exitCode, 0, found.stderr);
    assert.equal((await run([join(dir, 'lookup*.exe'), '/?'])).outcome, 'failed');
    const batch = join(dir, 'project-check.cmd');
    await writeFile(batch, '@echo off\r\nexit /b 13\r\n');
    assert.equal((await run([batch, 'ordinary-arg'])).exitCode, 13);
    const rejected = await run([batch, 'has&separator']);
    assert.equal(rejected.outcome, 'failed');
    assert.notEqual(rejected.exitCode, 13);
  }
});

test('command evidence is bounded and an unverifiable exit or a tool denial fails closed', async () => {
  const ctx = fixture(async () => ({
    isError: false,
    value: foreground(cwd, {
      stdout: { text: 'x'.repeat(22000) + 'tail' },
      exitCode: null,
    }),
  }));
  const r = await executeVerification(ctx, parent, cwd, defaultCommand, freshSignal());
  assert.equal(r.outcome, 'failed');
  assert.equal(r.stdoutTruncated, true);
  assert.ok(r.stdout.endsWith('tail') && r.stdout.length < 9000);
  for (const response of [
    { isError: true, error: { message: 'policy refused' } },
    { isError: false, value: foreground(join(cwd, 'elsewhere')) },
    { isError: false, value: foreground(cwd, { sandbox: { denied: true } }) },
    { isError: false, value: { kind: 'foreground' } },
  ]) {
    const host = fixture(async () => response);
    assert.equal(
      (await executeVerification(host, parent, cwd, defaultCommand, freshSignal())).outcome,
      'failed',
    );
    assert.equal(host.calls(), 1);
  }
  const hidden = fixture(async () => assert.fail(), {
    tools: { execute() {}, executable: () => undefined },
  });
  assert.equal(verifyCommandAvailable(hidden, parent), false);
  assert.equal(
    (await executeVerification(hidden, parent, cwd, defaultCommand, freshSignal())).outcome,
    'failed',
  );
});

test('deadline, cancellation, and host timeout promotion cannot report success', async () => {
  const waiting = fixture(async (_args, signal) => {
    await new Promise((resolve) => signal.addEventListener('abort', resolve, { once: true }));
    throw signal.reason;
  });
  const timed = await executeVerification(
    waiting,
    parent,
    cwd,
    { ...defaultCommand, timeoutMs: 20 },
    freshSignal(),
  );
  assert.equal(timed.timedOut, true);
  assert.equal(timed.outcome, 'failed');
  const aborted = new AbortController();
  aborted.abort();
  assert.equal(
    (await executeVerification(waiting, parent, cwd, defaultCommand, aborted.signal)).cancelled,
    true,
  );
  assert.equal(waiting.calls(), 1);
  let stopped = false;
  const events = [];
  parent.session.snapshotEvents = () => events;
  const promoted = fixture(
    async () => ({
      isError: false,
      value: { kind: 'promoted', jobId: 'check', timeoutMs: 200 },
    }),
    {
      jobs: {
        kill(id, owner) {
          assert.equal(id, 'check');
          assert.equal(owner, parent.id);
          stopped = true;
        },
        async wait() {
          assert.equal(stopped, true);
          events.push({
            type: 'job/settled',
            data: {
              owner: parent.id,
              jobId: 'check',
              kind: shell,
              producerReported: true,
              cause: 'kill',
              status: 'killed',
            },
          });
          return { status: 'killed' };
        },
      },
    },
  );
  const stopping = [];
  const early = await executeVerification(
    promoted,
    parent,
    cwd,
    defaultCommand,
    freshSignal(),
    (id) => stopping.push(id),
  );
  assert.deepEqual(stopping, ['check', undefined]);
  assert.equal(early.timedOut, false);
  assert.equal(early.outcome, 'failed');
  assert.match(early.stderr, /200 ms/);
  assert.equal(stopped, true);
  delete parent.session.snapshotEvents;
});

test(
  'a physically identical cwd uses the same directory identity as the runner',
  {
    skip: process.platform !== 'win32',
  },
  async () => {
    const alias = cwd.toUpperCase();
    const ctx = fixture(async () => ({ isError: false, value: foreground(alias) }));
    assert.equal(
      (await executeVerification(ctx, parent, cwd, defaultCommand, freshSignal())).outcome,
      'passed',
    );
  },
);

test('workflow preflight rejects a registered shell hidden by session assembly', async () => {
  const { preflightWorkflow } = await import('../workflow-preflight.js');
  const ctx = fixture(() => assert.fail(), {
    agents: { get: () => parent },
    jobs: {},
    systemPrompt: { assemble: async () => ({ tools: [] }) },
  });
  const preflight = await preflightWorkflow(
    ctx,
    { session: parent.id, template: { steps: [{ name: 'check', kind: 'verify' }] } },
    cwd,
  );
  assert.equal(preflight.ok, false);
  assert.equal(preflight.diagnostics[0].step, 'check');
  assert.equal(ctx.calls(), 0);
});

test('one scoped PTC dispatch returns a canonical shell value without parsing its output', async () => {
  const ctx = fixture(
    async (args, _signal, name) => {
      assert.equal(name, 'run_code');
      assert.ok(args.code.startsWith('return await tools.' + shell + '('));
      return { isError: false, value: { logs: [], result: foreground(cwd) } };
    },
    {
      systemPrompt: { assemble: async () => ({ tools: [{ name: 'run_code' }] }) },
      ptcRuntime: { language: 'typescript', programFormat: 'function-body' },
    },
  );
  assert.equal(
    (await executeVerification(ctx, parent, cwd, defaultCommand, freshSignal())).outcome,
    'passed',
  );
  assert.equal(ctx.calls(), 1);
});

test('every registry path requires evidence from the owning shell producer', async () => {
  const evidence = {
    jobId: 'j',
    owner: 's',
    kind: shell,
    status: 'killed',
    cause: 'kill',
    producerReported: true,
  };
  for (const path of ['pruned', 'already-finished', 'requested']) {
    const ctx = {
      get: () => ({
        kill() {
          if (path === 'pruned') throw Object.assign(Error('pruned'), { code: 'JOB_NOT_FOUND' });
          return path;
        },
        wait: async () => ({ status: 'failed' }),
      }),
    };
    const events = [];
    const owner = { id: 's', session: { snapshotEvents: () => events } };
    await assert.rejects(stopVerificationJob(ctx, owner, 'j'), /结束记录/);
    for (const change of [
      { cause: 'teardown', status: 'failed', producerReported: false },
      { producerReported: undefined },
      { kind: 'agent' },
      { owner: 'copied' },
      { jobId: 'other' },
    ]) {
      events[0] = { type: 'job/settled', data: { ...evidence, ...change } };
      await assert.rejects(stopVerificationJob(ctx, owner, 'j'), /结束记录/);
    }
    events[0] = { type: 'job/settled', data: evidence };
    await stopVerificationJob(ctx, owner, 'j');
  }
});

test('host sandbox preparation errors preserve their code without triggering a repair', async () => {
  const ctx = fixture(() => ({
    isError: true,
    error: { message: 'fixture diagnostic', info: { code: 'SANDBOX_PREPARATION_FAILED' } },
  }));
  const report = await executeVerification(ctx, parent, cwd, defaultCommand, freshSignal());
  assert.equal(report.hostErrorCode, 'SANDBOX_PREPARATION_FAILED');
  assert.match(report.summary, /沙箱准备失败.*未启动/);
  assert.equal(report.commandFailed, false);
  assert.equal(report.exitCode, null);
});
