import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  researchConfig,
  researchFor,
  solveCheckMarkers,
  solveCompatibilityMarkers,
  solveSanitizerMarkers,
  solveSampling,
  assertMarkers,
} from '../dist/kernel/research-config.js';
import { buildKernelPrompt } from '../dist/kernel/prompts.js';
import { classifySanitizer } from '../dist/kernel/sanitizer.js';
import { evidenceSchema } from '../dist/kernel/artifacts.js';
test('research snapshots preserve legacy default and reject unknown or edited contracts', () => {
  assert.equal(researchFor({}).id, 'diagonal-trtri');
  const c = researchConfig('direct-trsm');
  assert.equal(c.sizes.length * c.rhs.length, 78);
  assert.deepEqual(researchFor({ researchConfig: c }), c);
  c.rhs.pop();
  assert.throws(() => researchFor({ researchConfig: c }), /不兼容/);
  assert.throws(() => researchConfig('unknown'));
});
test('direct solver prompts exclude inverse objective and preserve stage boundaries', () => {
  const p = buildKernelPrompt({ kind: 'review', prompt: 'test' }, researchConfig('direct-trsm'));
  assert.match(p, /禁止形成任何三角逆/);
  assert.match(p, /前代\/回代/);
  assert.match(p, /本轮实现任务范围/);
  assert.doesNotMatch(p, /任务：输入仅为一张三角矩阵，FP32 批量求逆/);
  assert.match(p, /重构前的第一次审阅/);
});
test('fixed solver markers reject truncated or duplicate numerical evidence', () => {
  const rows = solveCheckMarkers(32);
  assert.equal(rows.length, 15);
  assertMarkers(rows.join('\n'), rows, ['CHECK,']);
  assert.throws(() => assertMarkers(rows.slice(1).join('\n'), rows, ['CHECK,']));
  assert.throws(() => assertMarkers([...rows, rows[0]].join('\n'), rows, ['CHECK,']));
  assert.equal(solveCompatibilityMarkers().length, 27);
});
test('sanitizer checks direct work markers instead of accepting inverse markers', () => {
  const rows = solveSanitizerMarkers(32),
    log = rows.join('\n') + '\n========= ERROR SUMMARY: 0 errors\n';
  assert.equal(classifySanitizer(log, 'memcheck', 32, false, rows), 'passed');
  assert.equal(classifySanitizer(log, 'memcheck', 32), 'blocked');
  assert.equal(classifySanitizer(log.replace(rows[0], ''), 'memcheck', 32, false, rows), 'blocked');
});
test('sampling and evidence identify n and RHS independently', () => {
  assert.deepEqual(solveSampling(32, 1), { groups: 3, iterations: 10 });
  assert.deepEqual(solveSampling(32, 4096), { groups: 1, iterations: 10 });
  assert.deepEqual(solveSampling(1024, 1), { groups: 1, iterations: 10 });
  const e = evidenceSchema.parse({
    passed: true,
    source: {},
    architectures: [80, 90, 120],
    sizes: [32],
    profile: 'full',
    performance: [{ n: 32, nrhs: 4096, uplo: 0, diag: 0, samples: [1], medianUs: 1 }],
    log: 'test',
    targetRuntimeVerified: false,
  });
  assert.equal(e.performance[0].nrhs, 4096);
  assert.equal(e.performance[0].nb, undefined);
});

test('prepare-only freezes direct-trsm inputs without starting a worker', async (t) => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { KernelStore } = await import('../dist/kernel/store.js');
  const { kernelCli } = await import('../dist/kernel/cli.js');
  if (!existsSync(researchConfig('direct-trsm').guide)) {
    t.skip('requires local solve-ref catalog');
    return;
  }
  const root = mkdtempSync(join(tmpdir(), 'solve-prepare-'));
  try {
    const project = join(root, 'project');
    for (const d of ['src', 'include', 'tests']) mkdirSync(join(project, d), { recursive: true });
    writeFileSync(join(project, 'src/solve.cu'), 'source');
    writeFileSync(join(project, 'include/api.h'), 'api');
    writeFileSync(join(project, 'tests/solve_workflow.cu'), 'trusted');
    const store = new KernelStore(join(root, 'runs'));
    await kernelCli(
      [
        'start',
        project,
        '--research',
        'direct-trsm',
        '--prepare-only',
        '--time-only',
        '--seconds',
        '28800',
        '--no-fast',
      ],
      store,
    );
    const [state] = store.list();
    assert.equal(state.status, 'ready');
    assert.equal(state.workerPid, undefined);
    assert.equal(state.calls, 0);
    assert.equal(state.budget.seconds, 28800);
    assert.equal(state.budget.calls, null);
    assert.equal(state.roles.developer.speed, 'standard');
    assert.equal(state.researchConfig.id, 'direct-trsm');
    const dir = store.dir(state.id);
    assert.ok(existsSync(join(dir, 'trusted/tests/solve_workflow.cu')));
    assert.equal(JSON.parse(readFileSync(join(dir, 'research-config.json'))).rhs.length, 13);
    assert.match(readFileSync(join(dir, 'research/README.txt'), 'utf8'), /直接三角求解/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
