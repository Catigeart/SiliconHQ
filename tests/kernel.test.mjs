import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { KernelStore, atomic, manifest, budgetSchema } from '../dist/kernel/store.js';
import { runKernel } from '../dist/kernel/runner.js';
import { command } from '../dist/kernel/process.js';

function fixture(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'kernel-test-'));
  const store = new KernelStore(join(root, '.llm-coder', 'kernel')),
    id = randomUUID(),
    dir = store.dir(id);
  mkdirSync(join(dir, 'baseline/src'), { recursive: true });
  mkdirSync(join(dir, 'baseline/include'), { recursive: true });
  writeFileSync(join(dir, 'baseline/src/kernel.cu'), 'original');
  writeFileSync(join(dir, 'baseline/include/api.h'), 'api');
  const config = { model: 'fixture', reasoningEffort: 'medium', speed: 'inherit' };
  const state = {
    id,
    project: join(dir, 'baseline'),
    createdAt: 'now',
    updatedAt: '',
    status: 'ready',
    stage: 'baseline',
    experiment: 1,
    budget: budgetSchema.parse({ experiments: 2, ...options.budget }),
    usedSeconds: 0,
    calls: 0,
    tokens: 0,
    profile: 'smoke',
    sizes: [32],
    blocks: [1],
    iterations: 1,
    roles: { planner: config, developer: config, reviewer: config },
    parent: join(dir, 'baseline'),
    threads: {},
    attempts: {},
    results: [],
  };
  store.save(state);
  atomic(join(dir, 'control.json'), { action: 'run' });
  const calls = [],
    checks = [];
  const deps = {
    async agent(s, st, input, signal) {
      calls.push(input.kind);
      signal.throwIfAborted();
      if (input.kind === 'closeout')
        return {
          status: s.closeout?.reason ?? 'time_limit',
          summary: 'saved',
          completedWork: [],
          unfinishedWork: ['cancelled round'],
          retainedFindings: [],
          nextSteps: ['new campaign'],
          limitations: ['smoke only'],
        };
      if (options.agent) return options.agent(s, st, input, signal, calls);
      if (input.kind === 'develop' || input.kind === 'refactor')
        writeFileSync(join(input.cwd, 'src/kernel.cu'), input.kind + s.experiment);
      if (input.kind === 'decide')
        return {
          action: options.action ?? 'continue',
          stopReason: 'goal_converged',
          disposition: 'retain',
          reason: 'fixture',
          nextHypothesis: 'next',
          parent: 'current',
        };
      if (input.kind === 'review' || input.kind === 'final_review')
        return { verdict: 'passed', summary: 'checked', findings: [], limitations: [] };
      return { summary: 'done' };
    },
    async verify(s, r, source, dest, performance, signal) {
      checks.push(dest);
      signal.throwIfAborted();
      mkdirSync(dest, { recursive: true });
      const passed = !(options.failCheck && dest.includes('first-check'));
      const result = {
        passed,
        source: manifest(source),
        architectures: [80, 90, 120],
        sizes: s.sizes,
        profile: s.profile,
        performance: performance
          ? [{ nb: 32, blocks: 1, uplo: 0, diag: 0, samples: [1, 1, 1, 1, 1], medianUs: 1 }]
          : [],
        log: 'fixture',
        targetRuntimeVerified: false,
      };
      atomic(join(dest, 'evidence.json'), result);
      return result;
    },
  };
  return {
    root,
    dir,
    id,
    store,
    calls,
    checks,
    deps,
    run: () => runKernel(id, store, deps),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
test('kernel runs five stages plus decision, archives isolated candidates and stops at experiment budget', async () => {
  const f = fixture();
  try {
    await f.run();
    const s = f.store.read(f.id);
    assert.equal(s.status, 'budget_exhausted');
    assert.equal(s.results.length, 2);
    assert.equal(s.calls, 12);
    assert.deepEqual(
      f.calls,
      Array(2).fill(['plan', 'develop', 'review', 'refactor', 'final_review', 'decide']).flat(),
    );
    assert.equal(readFileSync(join(f.dir, 'baseline/src/kernel.cu'), 'utf8'), 'original');
    assert.equal(
      readFileSync(join(f.dir, 'experiments/1/archived/src/kernel.cu'), 'utf8'),
      'refactor1',
    );
    assert.equal(
      readFileSync(join(f.dir, 'experiments/2/archived/src/kernel.cu'), 'utf8'),
      'refactor2',
    );
    const comparison = JSON.parse(readFileSync(join(f.dir, 'experiments/1/comparison.json')));
    assert.equal(comparison.localValidationPassed, false);
    assert.equal('mature' in comparison, false);
    assert.equal(comparison.targetRuntimeVerified, false);
    await assert.rejects(f.run(), /预算耗尽/);
  } finally {
    f.cleanup();
  }
});
test('kernel pause at stage boundary resumes without repeating completed stages', async () => {
  const f = fixture({ action: 'stop' });
  try {
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      const result = await base(...args);
      if (args[2].kind === 'develop') atomic(join(f.dir, 'control.json'), { action: 'pause' });
      return result;
    };
    await f.run();
    assert.equal(f.store.read(f.id).status, 'paused');
    assert.equal(f.store.read(f.id).stage, 'check');
    atomic(join(f.dir, 'control.json'), { action: 'run' });
    await f.run();
    assert.equal(f.store.read(f.id).status, 'completed');
    assert.equal(f.calls.filter((k) => k === 'develop').length, 1);
  } finally {
    f.cleanup();
  }
});
test('stop cancels active work then summarizes outside experimental budgets', async () => {
  const f = fixture({ budget: { calls: 1, stageSeconds: 1 } });
  try {
    const state = f.store.read(f.id);
    state.stage = 'develop';
    f.store.save(state);
    const base = f.deps.agent;
    let cancelled = false;
    f.deps.agent = async (...args) => {
      const [s, st, input, signal] = args;
      if (input.kind === 'closeout') {
        assert.equal(cancelled, true);
        assert.equal(signal.aborted, false);
        assert.equal(readFileSync(join(f.dir, 'stop-snapshot/src/kernel.cu'), 'utf8'), 'partial');
        assert.match(input.prompt, /用户请求停止/);
        atomic(join(f.dir, 'control.json'), { action: 'stop' });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.equal(signal.aborted, false);
        return base(...args);
      }
      writeFileSync(join(input.cwd, 'src/kernel.cu'), 'partial');
      atomic(join(f.dir, 'control.json'), { action: 'stop' });
      await new Promise((resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    };
    await f.run();
    const end = f.store.read(f.id);
    assert.equal(end.status, 'stopped');
    assert.equal(end.stage, 'closeout');
    assert.equal(end.closeout.status, 'completed');
    assert.equal(end.closeout.reason, 'user_stop');
    assert.equal(end.calls, 2);
    assert.equal(end.results[0].status, 'cancelled');
    assert.equal(end.closeout.stage, 'develop');
    assert.equal(f.checks.length, 0);
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'summary.json'))).status, 'user_stop');
    assert.ok(!existsSync(join(f.dir, 'lock')));
    await assert.rejects(f.run(), /已结束/);
  } finally {
    f.cleanup();
  }
});
test('kernel enforces model call budget before another call', async () => {
  const f = fixture({ budget: { calls: 1 } });
  try {
    await f.run();
    assert.equal(f.store.read(f.id).status, 'budget_exhausted');
    assert.deepEqual(f.calls, ['plan']);
  } finally {
    f.cleanup();
  }
});
test('kernel rejects promoting failed correctness and skips refactor/performance', async () => {
  const f = fixture({ failCheck: true });
  try {
    await f.run();
    const s = f.store.read(f.id);
    assert.equal(s.status, 'blocked');
    assert.match(s.error, /未通过/);
    assert.deepEqual(f.calls, ['plan', 'develop', 'decide']);
    assert.equal(s.results.length, 0);
  } finally {
    f.cleanup();
  }
});
test('kernel archives failed candidates when planner chooses reject and stop', async () => {
  const f = fixture({ failCheck: true });
  try {
    const base = f.deps.agent;
    f.deps.agent = async (...args) =>
      args[2].kind === 'decide'
        ? {
            action: 'stop',
            stopReason: 'goal_converged',
            disposition: 'reject',
            reason: 'failure',
            nextHypothesis: 'fix',
            parent: 'baseline',
          }
        : base(...args);
    await f.run();
    const s = f.store.read(f.id);
    assert.equal(s.status, 'completed');
    assert.equal(s.results[0].eligible, false);
    assert.ok(existsSync(join(f.dir, 'experiments/1/archived/src/kernel.cu')));
  } finally {
    f.cleanup();
  }
});
test('network failures do not consume semantic attempts and a saved window blocks sustained failure', async () => {
  const f = fixture({
    agent: async () => {
      throw new Error('provider unavailable');
    },
  });
  try {
    const state = f.store.read(f.id);
    state.networkRetry = { windowSeconds: 0, maxDelaySeconds: 1 };
    f.store.save(state);
    await f.run();
    assert.equal(f.store.read(f.id).status, 'blocked');
    assert.match(f.store.read(f.id).error, /重试窗口耗尽/);
    assert.equal(f.store.read(f.id).attempts['1:plan'], 1);
  } finally {
    f.cleanup();
  }
});
test('trusted command cancellation exits promptly', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'kernel-command-'));
  try {
    const controller = new AbortController();
    const task = command(
      [process.execPath, '-e', 'setTimeout(()=>{},30000)'],
      dir,
      join(dir, 'log'),
      controller.signal,
    );
    setTimeout(() => controller.abort(new Error('cancel test')), 50);
    await assert.rejects(task, /cancel test/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('kernel stage timeout is persisted as blocked without advancing the stage', async () => {
  const f = fixture({
    budget: { stageSeconds: 1 },
    agent: async (s, st, input, signal) =>
      new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      ),
  });
  try {
    await f.run();
    assert.equal(f.store.read(f.id).status, 'blocked');
    assert.equal(f.store.read(f.id).stage, 'plan');
    assert.match(f.store.read(f.id).error, /TimeoutError/);
  } finally {
    f.cleanup();
  }
});
test('kernel reported token budget prevents another model call', async () => {
  const f = fixture({ budget: { tokens: 10 } });
  try {
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      const result = await base(...args);
      args[0].tokens = 10;
      return result;
    };
    await f.run();
    assert.equal(f.store.read(f.id).status, 'budget_exhausted');
    assert.deepEqual(f.calls, ['plan']);
  } finally {
    f.cleanup();
  }
});
test('kernel refuses an active concurrent worker', async () => {
  const f = fixture();
  try {
    const release = f.store.lock(f.id);
    try {
      await assert.rejects(f.run(), /正在运行/);
    } finally {
      release();
    }
  } finally {
    f.cleanup();
  }
});
test('kernel reuses verified evidence when interrupted before its summary checkpoint', async () => {
  const f = fixture({ action: 'stop' });
  try {
    const base = f.deps.verify;
    let interrupted = false;
    f.deps.verify = async (...args) => {
      const value = await base(...args);
      if (args[3].endsWith('final-check') && !interrupted) {
        interrupted = true;
        throw new Error('simulated crash after evidence save');
      }
      return value;
    };
    await f.run();
    assert.equal(f.store.read(f.id).stage, 'final_check');
    assert.equal(f.store.read(f.id).status, 'blocked');
    const count = f.checks.length;
    await f.run();
    assert.equal(f.store.read(f.id).status, 'completed');
    assert.equal(f.checks.length, count);
    assert.equal(f.store.read(f.id).results[0].eligible, true);
  } finally {
    f.cleanup();
  }
});

test('kernel rejects changed frozen baseline before launching any tool or model', async () => {
  const f = fixture();
  try {
    atomic(join(f.dir, 'baseline-manifest.json'), manifest(join(f.dir, 'baseline')));
    writeFileSync(join(f.dir, 'baseline/src/kernel.cu'), 'changed externally');
    await f.run();
    assert.equal(f.store.read(f.id).status, 'blocked');
    assert.match(f.store.read(f.id).error, /基线源码被修改/);
    assert.equal(f.calls.length, 0);
    assert.equal(f.checks.length, 0);
  } finally {
    f.cleanup();
  }
});
test('kernel CLI status, steering, pause and detached resume operate on persistent records', async () => {
  const f = fixture();
  try {
    const invoke = (args) =>
      spawnSync(process.execPath, [resolve('dist/cli.js'), 'kernel', ...args], {
        env: { ...process.env, HOME: f.root },
        encoding: 'utf8',
        timeout: 5000,
      });
    assert.equal(JSON.parse(invoke(['status', f.id]).stdout).status, 'ready');
    assert.equal(invoke(['steer', f.id, 'prefer nb=512']).status, 0);
    assert.match(readFileSync(join(f.dir, 'steering.jsonl'), 'utf8'), /nb=512/);
    assert.equal(invoke(['pause', f.id]).status, 0);
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'control.json'))).action, 'pause');
    const state = f.store.read(f.id);
    state.status = 'paused';
    state.calls = state.budget.calls;
    f.store.save(state);
    const resumed = invoke(['resume', f.id]);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.match(resumed.stdout, /后台 PID/);
    for (let i = 0; i < 100 && f.store.read(f.id).status !== 'budget_exhausted'; i++)
      await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.store.read(f.id).status, 'budget_exhausted');
    assert.equal(f.store.read(f.id).calls, state.budget.calls);
    assert.equal(invoke(['resume', f.id]).status, 1);
  } finally {
    f.cleanup();
  }
});

test('planner can archive an incorrect experiment and automatically try a new one from baseline', async () => {
  const f = fixture({ action: 'stop' });
  try {
    const verify = f.deps.verify,
      agent = f.deps.agent;
    f.deps.verify = async (...args) => {
      const result = await verify(...args);
      if (args[0].experiment === 1 && args[3].endsWith('first-check')) {
        result.passed = false;
        atomic(join(args[3], 'evidence.json'), result);
      }
      return result;
    };
    f.deps.agent = async (...args) => {
      if (args[2].kind === 'decide' && args[0].experiment === 1)
        return {
          action: 'continue',
          stopReason: 'branch_complete',
          disposition: 'reject',
          reason: 'incorrect candidate',
          nextHypothesis: 'different approach',
          parent: 'baseline',
        };
      if (args[2].kind === 'plan' && args[0].experiment === 2) {
        assert.equal(readFileSync(join(args[2].cwd, 'src/kernel.cu'), 'utf8'), 'original');
        assert.match(args[2].prompt, /different approach/);
      }
      return agent(...args);
    };
    await f.run();
    const s = f.store.read(f.id);
    assert.equal(s.status, 'completed');
    assert.deepEqual(
      s.results.map((r) => r.eligible),
      [false, true],
    );
    assert.equal(s.experiment, 2);
  } finally {
    f.cleanup();
  }
});

test('time expiry cancels current work then runs planner closeout outside expired budgets', async () => {
  const f = fixture({ budget: { seconds: 10, calls: 1, stageSeconds: 1 } });
  try {
    const state = f.store.read(f.id);
    state.stage = 'develop';
    state.usedSeconds = 9.9;
    f.store.save(state);
    let cancelled = false,
      closed = false;
    f.deps.agent = async (s, store, input, signal) => {
      if (input.kind === 'closeout') {
        assert.equal(cancelled, true);
        assert.equal(signal.aborted, false);
        assert.match(
          readFileSync(join(f.dir, 'deadline-snapshot/src/kernel.cu'), 'utf8'),
          /partial/,
        );
        assert.equal(
          JSON.parse(readFileSync(join(f.dir, 'deadline-context.json'))).currentRoundVerified,
          false,
        );
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.equal(signal.aborted, false);
        closed = true;
        return {
          status: 'time_limit',
          summary: 'deadline summary',
          completedWork: [],
          unfinishedWork: ['partial'],
          retainedFindings: [],
          nextSteps: ['investigate'],
          limitations: ['not verified'],
        };
      }
      writeFileSync(join(input.cwd, 'src/kernel.cu'), 'partial');
      await new Promise((resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(signal.reason);
          },
          { once: true },
        ),
      );
    };
    await f.run();
    const end = f.store.read(f.id);
    assert.equal(closed, true);
    assert.equal(end.status, 'budget_exhausted');
    assert.equal(end.closeout.status, 'completed');
    assert.equal(end.calls, 2);
    assert.equal(end.results[0].status, 'cancelled');
    assert.equal(end.results[0].eligible, false);
    assert.ok(end.closeout.seconds >= 1);
    assert.match(readFileSync(join(f.dir, 'summary.txt'), 'utf8'), /deadline summary/);
  } finally {
    f.cleanup();
  }
});
test('failed deadline summary resumes only the planner summary and keeps frozen现场', async () => {
  const f = fixture({ budget: { seconds: 10 } });
  try {
    const state = f.store.read(f.id);
    state.usedSeconds = 10;
    f.store.save(state);
    let tries = 0;
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      assert.equal(args[2].kind, 'closeout');
      if (++tries === 1) throw new Error('summary provider failed');
      return base(...args);
    };
    await f.run();
    assert.equal(f.store.read(f.id).status, 'blocked');
    assert.equal(f.store.read(f.id).closeout.status, 'failed');
    const snapshot = readFileSync(join(f.dir, 'deadline-context.json'), 'utf8');
    await f.run();
    const end = f.store.read(f.id);
    assert.equal(end.status, 'budget_exhausted');
    assert.equal(end.closeout.status, 'completed');
    assert.equal(tries, 2);
    assert.equal(f.checks.length, 0);
    assert.equal(readFileSync(join(f.dir, 'deadline-context.json'), 'utf8'), snapshot);
  } finally {
    f.cleanup();
  }
});
test('unlimited budgets run beyond the former round and model-call limits', async () => {
  const f = fixture({
    budget: {
      experiments: null,
      calls: null,
      tokens: null,
      stageSeconds: null,
      seconds: null,
      attempts: null,
    },
  });
  try {
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      const result = await base(...args);
      if (args[2].kind === 'decide' && args[0].experiment === 3) result.action = 'stop';
      return result;
    };
    await f.run();
    const end = f.store.read(f.id);
    assert.equal(end.status, 'completed');
    assert.equal(end.results.length, 3);
    assert.equal(end.calls, 18);
  } finally {
    f.cleanup();
  }
});
test('time-only campaign continues after a branch finishes', async () => {
  const f = fixture({
    budget: { experiments: null, calls: null, tokens: null, stageSeconds: null, attempts: null },
    action: 'stop',
  });
  try {
    const state = f.store.read(f.id);
    state.timeOnly = true;
    f.store.save(state);
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      const result = await base(...args);
      if (args[2].kind === 'decide' && args[0].experiment === 1)
        result.stopReason = 'branch_complete';
      return result;
    };
    await f.run();
    assert.equal(f.store.read(f.id).results.length, 2);
    assert.equal(f.store.read(f.id).status, 'completed');
  } finally {
    f.cleanup();
  }
});

test('repeated stop leaves a deadline summary running and preserves its original reason', async () => {
  const f = fixture({ budget: { seconds: 10 } });
  try {
    const state = f.store.read(f.id);
    state.usedSeconds = 10;
    f.store.save(state);
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      assert.equal(args[2].kind, 'closeout');
      atomic(join(f.dir, 'control.json'), { action: 'stop' });
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.equal(args[3].aborted, false);
      return base(...args);
    };
    await f.run();
    assert.equal(f.store.read(f.id).status, 'budget_exhausted');
    assert.equal(f.store.read(f.id).closeout.status, 'completed');
    assert.equal(f.store.read(f.id).closeout.reason, 'time_limit');
    assert.equal(f.checks.length, 0);
  } finally {
    f.cleanup();
  }
});

function enableSanitizer(f, run) {
  const state = f.store.read(f.id);
  state.sanitizerPolicy = 'family-final-v1';
  f.store.save(state);
  let checks = 0;
  f.deps.sanitize = async (s, root, source, dest, signal) => {
    checks++;
    mkdirSync(dest, { recursive: true });
    const result = run ? await run(s, signal) : { status: 'passed', passed: true };
    const evidence = {
      ...result,
      source: manifest(source),
      sizes: s.sizes,
      profile: s.profile,
      policy: 'family-final-v1',
      targetRuntimeVerified: false,
      cases: [],
    };
    atomic(join(dest, 'evidence.json'), evidence);
    return evidence;
  };
  return () => checks;
}
test('family finalization runs sanitizer once then planner feedback, but ordinary rounds do not', async () => {
  const f = fixture();
  try {
    const count = enableSanitizer(f);
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      const result = await base(...args);
      if (args[2].kind === 'decide' && args[0].experiment === 2) result.action = 'finalize_family';
      if (args[2].kind === 'family_decide')
        return {
          familyAction: 'close',
          action: 'stop',
          stopReason: 'goal_converged',
          disposition: 'retain',
          parent: 'current',
          reason: 'checks passed',
          nextHypothesis: 'done',
        };
      return result;
    };
    await f.run();
    assert.equal(count(), 1);
    assert.equal(f.store.read(f.id).status, 'completed');
    assert.equal(f.calls.filter((v) => v === 'family_decide').length, 1);
    const c = JSON.parse(readFileSync(join(f.dir, 'experiments/2/comparison.json')));
    assert.equal(c.sanitizerStatus, 'passed');
    assert.equal(c.familyVerificationPassed, false); // smoke only
  } finally {
    f.cleanup();
  }
});
test('sanitizer failure feeds planner and permits a repair from current without retaining it', async () => {
  const f = fixture();
  try {
    const count = enableSanitizer(f, async (s) => ({
      status: s.experiment === 1 ? 'failed' : 'passed',
      passed: s.experiment !== 1,
    }));
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      const result = await base(...args);
      const s = args[0],
        kind = args[2].kind;
      if (kind === 'decide') result.action = 'finalize_family';
      if (kind === 'family_decide')
        return {
          familyAction: s.experiment === 1 ? 'keep_open' : 'close',
          action: s.experiment === 1 ? 'continue' : 'stop',
          stopReason: s.experiment === 1 ? 'branch_complete' : 'goal_converged',
          disposition: s.experiment === 1 ? 'archive' : 'retain',
          parent: 'current',
          reason: 'repair or finalize',
          nextHypothesis: 'repair synchronization',
        };
      if (kind === 'plan' && s.experiment === 2)
        assert.equal(readFileSync(join(args[2].cwd, 'src/kernel.cu'), 'utf8'), 'refactor1');
      return result;
    };
    await f.run();
    assert.equal(count(), 2);
    assert.equal(f.store.read(f.id).status, 'completed');
    assert.deepEqual(
      f.store.read(f.id).results.map((r) => r.eligible),
      [false, true],
    );
  } finally {
    f.cleanup();
  }
});
test('sanitizer environment blockage resumes final checks without repeating development', async () => {
  const f = fixture({ action: 'stop' });
  try {
    let attempt = 0;
    enableSanitizer(f, async () =>
      ++attempt === 1
        ? { status: 'blocked', passed: false, error: 'driver unavailable' }
        : { status: 'passed', passed: true },
    );
    const base = f.deps.agent;
    f.deps.agent = async (...args) =>
      args[2].kind === 'family_decide'
        ? {
            familyAction: 'close',
            action: 'stop',
            stopReason: 'goal_converged',
            disposition: 'retain',
            parent: 'current',
            reason: 'done',
            nextHypothesis: 'none',
          }
        : base(...args);
    await f.run();
    assert.equal(f.store.read(f.id).stage, 'sanitizer');
    assert.equal(f.store.read(f.id).status, 'blocked');
    await f.run();
    assert.equal(f.store.read(f.id).status, 'completed');
    assert.equal(f.calls.filter((k) => k === 'develop').length, 1);
  } finally {
    f.cleanup();
  }
});
test('deadline interrupts final sanitizer and goes to planner closeout without family approval', async () => {
  const f = fixture({ action: 'stop', budget: { seconds: 10, stageSeconds: null } });
  try {
    enableSanitizer(f, async (s, signal) => {
      s.usedSeconds = 10; // elapsed deadline is driven by real worker clock below
      await new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    });
    const state = f.store.read(f.id);
    state.usedSeconds = 9;
    f.store.save(state);
    await f.run();
    assert.equal(f.store.read(f.id).status, 'budget_exhausted');
    assert.equal(f.store.read(f.id).closeout.stage, 'sanitizer');
    assert.ok(f.calls.includes('closeout'));
    assert.ok(!f.calls.includes('family_decide'));
  } finally {
    f.cleanup();
  }
});
test('failed sanitizer cannot be retained even when planner claims success', async () => {
  const f = fixture({ action: 'stop' });
  try {
    enableSanitizer(f, async () => ({ status: 'failed', passed: false }));
    const base = f.deps.agent;
    f.deps.agent = async (...args) =>
      args[2].kind === 'family_decide'
        ? {
            familyAction: 'keep_open',
            action: 'stop',
            stopReason: 'goal_converged',
            disposition: 'retain',
            parent: 'current',
            reason: 'incorrect claim',
            nextHypothesis: 'none',
          }
        : base(...args);
    await f.run();
    const state = f.store.read(f.id);
    assert.equal(state.status, 'blocked');
    assert.equal(state.stage, 'family_decide');
    assert.equal(state.results.length, 0);
    assert.match(state.error, /提升未通过/);
  } finally {
    f.cleanup();
  }
});
test('full profile marks family verified only after sanitizer plus planner final feedback', async () => {
  const f = fixture({ action: 'stop' });
  try {
    enableSanitizer(f);
    const state = f.store.read(f.id);
    state.profile = 'full';
    f.store.save(state);
    const base = f.deps.agent;
    f.deps.agent = async (...args) =>
      args[2].kind === 'family_decide'
        ? {
            familyAction: 'close',
            action: 'stop',
            stopReason: 'goal_converged',
            disposition: 'retain',
            parent: 'current',
            reason: 'verified',
            nextHypothesis: 'none',
          }
        : base(...args);
    await f.run();
    const comparison = JSON.parse(readFileSync(join(f.dir, 'experiments/1/comparison.json')));
    assert.equal(comparison.familyVerificationPassed, true);
    assert.equal(comparison.targetRuntimeVerified, false);
  } finally {
    f.cleanup();
  }
});

test('a queued stop takes precedence over pause/budget checks and never starts baseline', async () => {
  const f = fixture({ budget: { calls: 1 } });
  try {
    const state = f.store.read(f.id);
    state.status = 'paused';
    state.calls = 1;
    f.store.save(state);
    atomic(join(f.dir, 'control.json'), { action: 'stop' });
    await f.run();
    assert.equal(f.store.read(f.id).status, 'stopped');
    assert.deepEqual(f.calls, ['closeout']);
    assert.equal(f.checks.length, 0);
    assert.equal(f.store.read(f.id).closeout.reason, 'user_stop');
  } finally {
    f.cleanup();
  }
});
test('failed user-stop summary resumes only summary and preserves frozen context', async () => {
  const f = fixture();
  try {
    atomic(join(f.dir, 'control.json'), { action: 'stop' });
    const base = f.deps.agent;
    let attempts = 0;
    f.deps.agent = async (...args) => {
      assert.equal(args[2].kind, 'closeout');
      if (++attempts === 1) throw new Error('summary unavailable');
      return base(...args);
    };
    await f.run();
    assert.equal(f.store.read(f.id).status, 'blocked');
    assert.equal(f.store.read(f.id).closeout.status, 'failed');
    const context = readFileSync(join(f.dir, 'stop-context.json'), 'utf8');
    atomic(join(f.dir, 'control.json'), { action: 'run' });
    await f.run();
    assert.equal(f.store.read(f.id).status, 'stopped');
    assert.equal(f.store.read(f.id).closeout.status, 'completed');
    assert.equal(f.checks.length, 0);
    assert.equal(readFileSync(join(f.dir, 'stop-context.json'), 'utf8'), context);
    assert.equal(attempts, 2);
  } finally {
    f.cleanup();
  }
});
test('stop during sanitizer cancels checks and runs planner summary instead of family decision', async () => {
  const f = fixture({ action: 'stop' });
  try {
    enableSanitizer(f, async (s, signal) => {
      atomic(join(f.dir, 'control.json'), { action: 'stop' });
      await new Promise((resolve, reject) =>
        signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
      );
    });
    await f.run();
    const end = f.store.read(f.id);
    assert.equal(end.status, 'stopped');
    assert.equal(end.closeout.stage, 'sanitizer');
    assert.equal(end.closeout.reason, 'user_stop');
    assert.ok(f.calls.includes('closeout'));
    assert.ok(!f.calls.includes('family_decide'));
  } finally {
    f.cleanup();
  }
});
test('CLI stop starts an idle worker only for closeout and completed stop cannot resume', async () => {
  const f = fixture();
  try {
    const invoke = (args) =>
      spawnSync(process.execPath, [resolve('dist/cli.js'), 'kernel', ...args], {
        env: { ...process.env, HOME: f.root },
        encoding: 'utf8',
        timeout: 5000,
      });
    const state = f.store.read(f.id);
    state.status = 'paused';
    f.store.save(state);
    // Cached report avoids a real provider call while exercising the actual background worker.
    atomic(join(f.dir, 'summary.json'), {
      status: 'user_stop',
      summary: 'cached stop summary',
      completedWork: [],
      unfinishedWork: ['baseline'],
      retainedFindings: [],
      nextSteps: [],
      limitations: [],
    });
    const stopped = invoke(['stop', f.id]);
    assert.equal(stopped.status, 0, stopped.stderr);
    assert.match(stopped.stdout, /planner/);
    assert.match(stopped.stdout, /后台 PID/);
    for (let i = 0; i < 100 && f.store.read(f.id).closeout?.status !== 'completed'; i++)
      await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(f.store.read(f.id).status, 'stopped');
    assert.equal(f.store.read(f.id).closeout.reason, 'user_stop');
    assert.equal(f.store.read(f.id).calls, 0);
    assert.match(readFileSync(join(f.dir, 'summary.txt'), 'utf8'), /cached stop summary/);
    const again = invoke(['stop', f.id]);
    assert.equal(again.status, 0);
    assert.doesNotMatch(again.stdout, /后台 PID/);
    assert.equal(invoke(['resume', f.id]).status, 1);
  } finally {
    f.cleanup();
  }
});

test('TLS EOF retries same developer with partial edits and does not spend another semantic attempt', async () => {
  const f = fixture({ action: 'stop' });
  try {
    const base = f.deps.agent;
    let tries = 0;
    f.deps.retryDelay = async () => {};
    f.deps.agent = async (...args) => {
      if (args[2].kind === 'develop') {
        if (tries++ === 0) {
          writeFileSync(join(args[2].cwd, 'src/kernel.cu'), 'partial');
          throw new Error('stream disconnected: tls handshake eof');
        }
        assert.equal(readFileSync(join(args[2].cwd, 'src/kernel.cu'), 'utf8'), 'partial');
        assert.match(args[2].prompt, /勿重复应用/);
      }
      return base(...args);
    };
    await f.run();
    const state = f.store.read(f.id);
    assert.equal(state.status, 'completed');
    assert.equal(state.attempts['1:develop'], 1);
    assert.equal(tries, 2);
    assert.ok(existsSync(join(f.dir, 'experiments/1/EXPERIMENT.md')));
    assert.ok(existsSync(join(f.dir, 'INDEX.md')));
  } finally {
    f.cleanup();
  }
});
test('pause interrupts a network retry wait and keeps the stage resumable', async () => {
  const f = fixture();
  try {
    f.deps.agent = async () => {
      atomic(join(f.dir, 'control.json'), { action: 'pause' });
      throw new Error('tls handshake eof');
    };
    await f.run();
    const state = f.store.read(f.id);
    assert.equal(state.status, 'paused');
    assert.equal(state.stage, 'plan');
    assert.equal(state.calls, 1);
  } finally {
    f.cleanup();
  }
});
test('references outside library are corrected by planner before development', async () => {
  const f = fixture({ action: 'stop' });
  try {
    const state = f.store.read(f.id);
    const library = join(f.dir, 'library');
    mkdirSync(library);
    state.references = { root: library, guide: library };
    f.store.save(state);
    let plans = 0;
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      if (args[2].kind === 'plan') {
        if (plans++ === 0)
          return {
            algorithmFamily: 'warp',
            references: [{ path: join(f.dir, 'baseline/src/kernel.cu'), sha256: '0'.repeat(64) }],
          };
        assert.match(args[2].prompt, /控制器校验错误/);
        return { algorithmFamily: 'warp', references: [], hypothesis: 'local analysis' };
      }
      return base(...args);
    };
    await f.run();
    assert.equal(f.store.read(f.id).status, 'completed');
    assert.equal(plans, 2);
    assert.ok(existsSync(join(f.dir, 'experiments/1/plan-invalid-0.json')));
  } finally {
    f.cleanup();
  }
});
test('diagnostics run directly and cannot masquerade as code validation', async () => {
  const f = fixture({ budget: { experiments: 1 } });
  try {
    f.deps.agent = async (s, st, input) =>
      input.kind === 'plan'
        ? {
            task: 'diagnose',
            familyId: 'warp',
            diagnostics: [
              {
                kind: 'kernels',
                targets: ['baseline'],
                sizes: [32],
                repeats: 1,
                reason: 'measure',
              },
            ],
          }
        : {
            action: 'continue',
            stopReason: 'branch_complete',
            disposition: 'archive',
            reason: 'diagnostic only',
            nextHypothesis: 'implement',
            parent: 'current',
          };
    let diagnostics = 0;
    f.deps.diagnose = async () => {
      diagnostics++;
      return { status: 'completed', requests: [] };
    };
    await f.run();
    assert.equal(diagnostics, 1);
    assert.equal(f.checks.length, 1);
    assert.equal(f.store.read(f.id).results[0].eligible, false);
    assert.ok(!existsSync(join(f.dir, 'experiments/1/archived')));
    assert.ok(existsSync(join(f.dir, 'experiments/1/EXPERIMENT.md')));
  } finally {
    f.cleanup();
  }
});
test('unchanged implementation skips checks and returns no-change evidence to planner', async () => {
  const f = fixture({ budget: { experiments: 1 } });
  try {
    f.deps.agent = async (s, st, input) =>
      input.kind === 'diagnostic_decide'
        ? {
            action: 'continue',
            stopReason: 'branch_complete',
            disposition: 'archive',
            reason: 'no changes',
            nextHypothesis: 'diagnose',
            parent: 'current',
          }
        : { summary: 'unchanged' };
    await f.run();
    assert.equal(f.checks.length, 1);
    assert.equal(f.store.read(f.id).results[0].eligible, false);
    assert.equal(
      JSON.parse(readFileSync(join(f.dir, 'experiments/1/diagnostics.json'))).status,
      'no_change',
    );
  } finally {
    f.cleanup();
  }
});
test('ending a parameter branch does not automatically trigger sanitizer', async () => {
  const f = fixture({ action: 'stop', budget: { experiments: 1 } });
  try {
    const count = enableSanitizer(f);
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      const r = await base(...args);
      if (args[2].kind === 'decide') r.stopReason = 'branch_complete';
      return r;
    };
    await f.run();
    assert.equal(count(), 0);
    assert.equal(f.store.read(f.id).results.length, 1);
  } finally {
    f.cleanup();
  }
});
test('new family cannot finalize without explicit closure and representatives', async () => {
  const f = fixture({ action: 'stop' });
  try {
    const count = enableSanitizer(f);
    const base = f.deps.agent;
    f.deps.agent = async (...args) =>
      args[2].kind === 'plan'
        ? { familyId: 'warp', algorithmFamily: 'warp', task: 'implement' }
        : base(...args);
    await f.run();
    assert.equal(count(), 0);
    assert.equal(f.store.read(f.id).status, 'blocked');
    assert.match(f.store.read(f.id).error, /算法族结束/);
  } finally {
    f.cleanup();
  }
});
test('explicit family closure preserves representatives and closes only after successful checks', async () => {
  const f = fixture({ action: 'stop', budget: { experiments: 1 } });
  try {
    const count = enableSanitizer(f);
    const base = f.deps.agent;
    const closure = {
      completedHypotheses: ['shared merge'],
      deferredHypotheses: ['A100 tuning'],
      reason: 'enough variants',
      representatives: [{ experiment: 1, reason: 'portable candidate' }],
    };
    f.deps.agent = async (...args) => {
      if (args[2].kind === 'plan')
        return { familyId: 'warp', algorithmFamily: 'warp', task: 'implement' };
      if (args[2].kind === 'family_decide')
        return {
          familyAction: 'close',
          action: 'stop',
          stopReason: 'goal_converged',
          disposition: 'retain',
          parent: 'current',
          reason: 'validated',
          nextHypothesis: 'done',
        };
      const r = await base(...args);
      if (args[2].kind === 'decide') r.familyClosure = closure;
      return r;
    };
    await f.run();
    assert.equal(count(), 1);
    assert.equal(f.store.read(f.id).status, 'completed');
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'families.json'))).warp.status, 'closed');
    assert.match(readFileSync(join(f.dir, 'FAMILY.md'), 'utf8'), /portable candidate/);
  } finally {
    f.cleanup();
  }
});

test('diagnostic pause advances to a new plan and does not replay cached pause forever', async () => {
  const f = fixture();
  try {
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      if (args[0].experiment === 1) {
        if (args[2].kind === 'plan')
          return { task: 'diagnose', diagnostics: [{ kind: 'codegen' }] };
        return {
          action: 'pause',
          stopReason: 'branch_complete',
          disposition: 'archive',
          parent: 'current',
          reason: 'inspect',
          nextHypothesis: 'implement',
        };
      }
      const result = await base(...args);
      if (args[2].kind === 'decide') result.action = 'stop';
      return result;
    };
    f.deps.diagnose = async () => ({ status: 'completed', requests: [] });
    await f.run();
    assert.equal(f.store.read(f.id).status, 'paused');
    assert.equal(f.store.read(f.id).stage, 'plan');
    assert.equal(f.store.read(f.id).experiment, 2);
    atomic(join(f.dir, 'control.json'), { action: 'run' });
    await f.run();
    assert.equal(f.store.read(f.id).status, 'completed');
  } finally {
    f.cleanup();
  }
});
test('failed historical family representative is reported to planner and prevents closing the family', async () => {
  const f = fixture({ budget: { experiments: 2 } });
  try {
    enableSanitizer(f);
    const base = f.deps.agent;
    f.deps.sanitize = async (s, root, source, dest) => ({
      status: source.includes('experiments/1/') ? 'failed' : 'passed',
      passed: !source.includes('experiments/1/'),
      source: manifest(source),
      sizes: s.sizes,
      profile: s.profile,
      policy: 'family-final-v1',
      targetRuntimeVerified: false,
      cases: [],
    });
    f.deps.agent = async (...args) => {
      const [s, st, input] = args;
      if (input.kind === 'plan')
        return { familyId: 'warp', algorithmFamily: 'warp', task: 'implement' };
      if (input.kind === 'family_decide') {
        assert.match(input.prompt, /representative-1.json/);
        return {
          familyAction: 'keep_open',
          action: 'continue',
          stopReason: 'branch_complete',
          disposition: 'archive',
          parent: 'current',
          reason: 'historical representative failed',
          nextHypothesis: 'repair or drop it',
        };
      }
      const result = await base(...args);
      if (input.kind === 'decide' && s.experiment === 2) {
        result.action = 'finalize_family';
        result.familyClosure = {
          completedHypotheses: ['test'],
          deferredHypotheses: [],
          reason: 'done',
          representatives: [
            { experiment: 1, reason: 'variant' },
            { experiment: 2, reason: 'current' },
          ],
        };
      }
      return result;
    };
    await f.run();
    assert.equal(f.store.read(f.id).status, 'budget_exhausted');
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'families.json'))).warp.status, 'open');
    assert.equal(
      JSON.parse(readFileSync(join(f.dir, 'experiments/2/comparison.json')))
        .familyVerificationPassed,
      false,
    );
  } finally {
    f.cleanup();
  }
});

const researchQuestion = {
  id: 'warp-capacity',
  problem: 'Can the shared algorithm fit?',
  decision: 'Choose shared or split',
  transferableInsight: 'capacity formula',
  stopWhen: 'resource bound and correctness established',
  purpose: 'algorithm-hypothesis',
  justification: 'needed for the structural decision',
  measurementUse: 'structural-decision',
  successAction: 'keep algorithm',
  failureAction: 'choose split',
};
const researchOutcome = {
  status: 'ongoing',
  conclusion: 'more structural evidence needed',
  transferableFindings: ['capacity formula'],
  targetPlatformWork: ['tune on A100'],
};
const portingGuide = {
  algorithmSummary: 'shared warp algorithm',
  defaultConfiguration: ['WARPS=4'],
  parameterConstraints: ['only default instance tested'],
  resourceNotes: ['shared memory depends on tile size'],
  portableFindings: ['same FP32 order'],
  targetPlatformWork: ['A100/H800 runtime and tuning'],
  abandonedDirections: ['sm120 ranking'],
};
test('policy rejection is fed back to planner before any parameter development starts', async () => {
  const f = fixture({ budget: { experiments: 1 } });
  try {
    const state = f.store.read(f.id);
    state.researchMode = 'algorithm-exploration';
    f.store.save(state);
    let plans = 0;
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      if (args[2].kind === 'plan')
        return {
          task: 'implement',
          familyId: 'warp',
          algorithmFamily: 'warp',
          changeKind: 'parameter',
          researchQuestion: {
            ...researchQuestion,
            purpose: plans++ === 0 ? 'target-tuning' : 'resource-boundary',
          },
        };
      const r = await base(...args);
      if (args[2].kind === 'decide') r.questionOutcome = researchOutcome;
      return r;
    };
    await f.run();
    assert.equal(f.store.read(f.id).status, 'budget_exhausted');
    assert.equal(plans, 2);
    assert.equal(f.calls.filter((k) => k === 'develop').length, 1);
    assert.ok(existsSync(join(f.dir, 'QUESTIONS.md')));
  } finally {
    f.cleanup();
  }
});
test('archive family finalization runs only representative sanitizer and planner, and writes a porting guide', async () => {
  const f = fixture({ budget: { experiments: 2 } });
  try {
    const state = f.store.read(f.id);
    state.researchMode = 'algorithm-exploration';
    state.profile = 'full';
    f.store.save(state);
    const count = enableSanitizer(f);
    const base = f.deps.agent;
    f.deps.agent = async (...args) => {
      const [s, st, input] = args;
      if (input.kind === 'plan')
        return {
          task: s.experiment === 1 ? 'implement' : 'finalize_family',
          familyId: 'warp',
          algorithmFamily: 'warp',
          changeKind: s.experiment === 1 ? 'algorithm' : 'diagnostic',
          researchQuestion,
          ...(s.experiment === 2
            ? {
                finalization: {
                  completedHypotheses: ['capacity'],
                  deferredHypotheses: ['target tuning'],
                  reason: 'portable framework ready',
                  representatives: [{ experiment: 1, reason: 'validated default' }],
                  portingGuide,
                },
              }
            : {}),
        };
      if (input.kind === 'family_decide')
        return {
          familyAction: 'close',
          action: 'continue',
          stopReason: 'branch_complete',
          disposition: 'archive',
          parent: 'current',
          reason: 'representative passed',
          nextHypothesis: 'new algorithm family',
          questionOutcome: { ...researchOutcome, status: 'supported' },
        };
      const r = await base(...args);
      if (input.kind === 'decide') r.questionOutcome = researchOutcome;
      return r;
    };
    await f.run();
    const s = f.store.read(f.id);
    assert.equal(s.status, 'budget_exhausted', s.error);
    assert.equal(count(), 1);
    assert.equal(f.checks.length, 3);
    assert.equal(f.calls.filter((k) => k === 'develop').length, 1);
    assert.equal(JSON.parse(readFileSync(join(f.dir, 'families.json'))).warp.status, 'closed');
    assert.equal(
      JSON.parse(readFileSync(join(f.dir, 'questions.json')))['warp-capacity'].status,
      'supported',
    );
    assert.match(readFileSync(join(f.dir, 'FAMILY.md'), 'utf8'), /A100\/H800 runtime/);
    assert.ok(!existsSync(join(f.dir, 'experiments/2/archived')));
  } finally {
    f.cleanup();
  }
});
test('CLI research mode change is idle-only and preserves time budget, roles and experiment boundary', () => {
  const f = fixture();
  try {
    const state = f.store.read(f.id);
    state.status = 'paused';
    state.stage = 'review';
    state.usedSeconds = 123;
    f.store.save(state);
    const invoke = () =>
      spawnSync(
        process.execPath,
        [resolve('dist/cli.js'), 'kernel', 'research-mode', f.id, 'algorithm-exploration'],
        { env: { ...process.env, HOME: f.root }, encoding: 'utf8', timeout: 5000 },
      );
    const release = f.store.lock(f.id);
    try {
      assert.notEqual(invoke().status, 0);
    } finally {
      release();
    }
    const result = invoke();
    assert.equal(result.status, 0, result.stderr);
    const after = f.store.read(f.id);
    assert.equal(after.researchMode, 'algorithm-exploration');
    assert.equal(after.researchPolicyStart, 2);
    assert.equal(after.usedSeconds, 123);
    assert.deepEqual(after.roles, state.roles);
    assert.deepEqual(after.budget, state.budget);
  } finally {
    f.cleanup();
  }
});

for (const outcome of ['supported', 'deferred'])
  test(`implementation family closes while campaign continues and question is ${outcome}`, async () => {
    const f = fixture({ budget: { experiments: 1 } });
    try {
      const count = enableSanitizer(f),
        base = f.deps.agent;
      f.deps.agent = async (...args) => {
        if (args[2].kind === 'plan')
          return { familyId: 'warp', algorithmFamily: 'warp', task: 'implement' };
        if (args[2].kind === 'family_decide')
          return {
            familyAction: 'close',
            action: 'continue',
            stopReason: 'branch_complete',
            disposition: 'archive',
            parent: 'current',
            reason: 'family done; campaign continues',
            nextHypothesis: 'another family',
            questionOutcome: {
              status: outcome,
              conclusion: 'target runtime separate',
              transferableFindings: [],
              targetPlatformWork: ['A100'],
            },
          };
        const d = await base(...args);
        if (args[2].kind === 'decide') {
          d.action = 'finalize_family';
          d.familyClosure = {
            completedHypotheses: ['implemented'],
            deferredHypotheses: ['A100'],
            reason: 'representative ready',
            representatives: [{ experiment: 1, reason: 'default' }],
          };
        }
        return d;
      };
      await f.run();
      assert.equal(f.store.read(f.id).status, 'budget_exhausted');
      assert.equal(count(), 1);
      const family = JSON.parse(readFileSync(join(f.dir, 'families.json'))).warp;
      assert.equal(family.status, 'closed');
      assert.equal(family.familyAction, 'close');
      assert.equal(family.representativesVerified, true);
    } finally {
      f.cleanup();
    }
  });
test('legacy cached final decision missing familyAction is corrected without rerunning validation', async () => {
  const f = fixture({ budget: { experiments: 1 } });
  try {
    const count = enableSanitizer(f),
      base = f.deps.agent;
    let feedbacks = 0;
    f.deps.agent = async (...args) => {
      if (args[2].kind === 'family_decide')
        return {
          action: 'continue',
          stopReason: 'branch_complete',
          disposition: 'archive',
          parent: 'current',
          reason: 'done',
          nextHypothesis: 'next',
          ...(feedbacks++ ? { familyAction: 'close' } : {}),
        };
      const r = await base(...args);
      if (args[2].kind === 'decide') r.action = 'finalize_family';
      return r;
    };
    await f.run();
    assert.equal(f.store.read(f.id).status, 'budget_exhausted');
    assert.equal(feedbacks, 2);
    assert.equal(count(), 1);
    assert.equal(f.checks.length, 3);
  } finally {
    f.cleanup();
  }
});
