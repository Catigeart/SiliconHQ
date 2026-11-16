import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { instrumentSolverTests, numericalFailures } from '../dist/kernel/numerical.js';
import { enableNumericalDiagnostics } from '../dist/kernel/upgrade-diagnostics.js';
import { treeManifest, atomic } from '../dist/kernel/store.js';
import { diagnosticCapabilities } from '../dist/kernel/diagnostics.js';
import { researchConfig } from '../dist/kernel/research-config.js';
const original = readFileSync(new URL('./fixtures/solve-workflow-v1.cu', import.meta.url), 'utf8');
test('instrumentation retains acceptance predicates and orders D2D completion before nonblocking solve', () => {
  const out = instrumentSolverTests(original);
  assert.equal(instrumentSolverTests(out), out);
  assert.match(
    out,
    /cudaMemcpy\(x.p[\s\S]*?check\(cudaDeviceSynchronize\(\)\);\s*cudaStream_t stream/,
  );
  for (const predicate of [
    'std::abs(value-expected)<=1e-5*std::max(1.,std::abs(expected))',
    'value<=1e-5f',
    'initialize_a<<<128,256>>>',
    'initialize_b<<<128,256>>>',
  ])
    assert.ok(out.includes(predicate));
  assert.throws(() =>
    instrumentSolverTests(
      original.replace('void check(cudaError_t e)', 'void changed(cudaError_t e)'),
    ),
  );
});
test('numerical JSON rejects malformed evidence and preserves nonfinite values explicitly', () => {
  const failure = {
    schemaVersion: 1,
    kind: 'nonfinite solve output',
    n: 512,
    nrhs: 2048,
    family: 0,
    side: 0,
    uplo: 0,
    trans: 0,
    diag: 0,
    alpha: 1,
    row: 0,
    rhsIndex: 1918,
    actual: null,
    expected: 1,
    actualText: 'nan',
    absoluteError: null,
    tolerance: 1e-5,
    lda: 640,
    ldb: 640,
    ldx: 640,
    launchStatus: 0,
    syncStatus: 0,
    cudaLastError: 0,
  };
  assert.deepEqual(numericalFailures('noise\nNUMERICAL_FAILURE,' + JSON.stringify(failure)), [
    failure,
  ]);
  assert.throws(() => numericalFailures('NUMERICAL_FAILURE,{}'));
  assert.throws(() => numericalFailures('NUMERICAL_FAILURE,broken'));
});
test('trusted migration preserves backup, audits hashes, is idempotent and rejects tampering', () => {
  const root = mkdtempSync(join(tmpdir(), 'numerical-upgrade-'));
  try {
    mkdirSync(join(root, 'trusted/tests'), { recursive: true });
    const file = join(root, 'trusted/tests/solve_workflow.cu');
    writeFileSync(file, original);
    atomic(join(root, 'trusted-manifest.json'), treeManifest(join(root, 'trusted')));
    const s = { status: 'blocked', researchConfig: researchConfig('direct-trsm') };
    assert.ok(!('numerical' in diagnosticCapabilities(s, root)));
    const result = enableNumericalDiagnostics(s, root);
    assert.equal(result.changed, true);
    assert.equal(
      readFileSync(join(root, 'trusted-before-numerical-v1/tests/solve_workflow.cu'), 'utf8'),
      original,
    );
    assert.ok('numerical' in diagnosticCapabilities(s, root));
    assert.equal(enableNumericalDiagnostics(s, root).changed, false);
    assert.throws(() => enableNumericalDiagnostics({ ...s, status: 'running' }, root));
    writeFileSync(file, readFileSync(file, 'utf8') + 'tampered');
    assert.throws(() => enableNumericalDiagnostics(s, root));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('upgrade resumes a crash between test replacement and manifest commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'numerical-crash-'));
  try {
    mkdirSync(join(root, 'trusted/tests'), { recursive: true });
    writeFileSync(join(root, 'trusted/tests/solve_workflow.cu'), original);
    const old = treeManifest(join(root, 'trusted'));
    atomic(join(root, 'trusted-manifest.json'), old);
    const s = { status: 'blocked', researchConfig: researchConfig('direct-trsm') };
    enableNumericalDiagnostics(s, root);
    const auditFile = join(root, 'numerical-diagnostics-upgrade.json');
    const audit = JSON.parse(readFileSync(auditFile, 'utf8'));
    atomic(auditFile, { ...audit, status: 'pending' });
    atomic(join(root, 'trusted-manifest.json'), old);
    assert.equal(enableNumericalDiagnostics(s, root).changed, true);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, 'trusted-manifest.json'), 'utf8')),
      treeManifest(join(root, 'trusted')),
    );
    assert.equal(JSON.parse(readFileSync(auditFile, 'utf8')).status, 'completed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
