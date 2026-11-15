import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { transient } from '../dist/kernel/budget.js';
import { evidenceKey, loadEvidence, saveEvidence } from '../dist/kernel/evidence-cache.js';
import { kernelRows, diagnosticSource } from '../dist/kernel/diagnostics.js';
import { registerFamily } from '../dist/kernel/families.js';
import { atomic } from '../dist/kernel/store.js';
test('transport errors are distinguished from permanent authentication/schema errors', () => {
  assert.equal(transient({ status: 401, message: '503' }), false);
  assert.equal(transient({ status: 503 }), true);
  assert.equal(transient(new Error('tls handshake eof')), true);
  assert.equal(transient({ cause: { code: 'ECONNRESET' } }), true);
  assert.equal(transient(new Error('invalid schema')), false);
});
test('evidence cache rejects altered or deleted logs and isolates environment identities', () => {
  const root = mkdtempSync(join(tmpdir(), 'evidence-test-'));
  try {
    const path = join(root, 'check.log');
    writeFileSync(path, 'PASS');
    const key = evidenceKey({ source: 'a', gpu: 'one' });
    saveEvidence(root, key, { passed: true }, [path]);
    assert.equal(loadEvidence(root, key).evidence.passed, true);
    assert.equal(loadEvidence(root, evidenceKey({ source: 'a', gpu: 'two' })), undefined);
    writeFileSync(path, 'FAIL');
    assert.equal(loadEvidence(root, key), undefined);
    rmSync(path);
    assert.equal(loadEvidence(root, key), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('kernel diagnostics preserve per-launch identities, geometry and units', () => {
  const report =
    '"ID","Kernel Name","Grid Size","Block Size","Metric Name","Metric Unit","Metric Value"\n"0","stage0","(4,1,1)","(256,1,1)","gpu__time_duration.sum","nsecond","1,200"';
  const rows = kernelRows(report);
  assert.equal(rows[0].us, 1.2);
  assert.equal(rows[0].kernel, 'stage0');
  assert.equal(rows[0].grid, '(4,1,1)');
  assert.throws(() => kernelRows('==WARNING== unstable\n' + report));
  assert.throws(() => kernelRows('empty'));
  assert.throws(() => diagnosticSource('/tmp', '../../anything'));
});
test('closed families require explicit reopening and new families need a structural reason', () => {
  const root = mkdtempSync(join(tmpdir(), 'family-test-'));
  try {
    mkdirSync(join(root, 'experiments/1/archived'), { recursive: true });
    atomic(join(root, 'experiments/1/plan.json'), { familyId: 'warp' });
    const state = { experiment: 2, parent: join(root, 'experiments/1/archived') };
    atomic(join(root, 'families.json'), { warp: { status: 'closed', experiments: [1] } });
    assert.throws(() => registerFamily(root, state, { familyId: 'warp' }), /reopenReason/);
    assert.throws(() => registerFamily(root, state, { familyId: 'other' }), /familyChangeReason/);
    registerFamily(root, state, { familyId: 'warp', reopenReason: 'new device evidence' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { codegenSummary } from '../dist/kernel/diagnostics.js';
test('codegen summary distinguishes architecture and reports instruction extent rather than guessed ELF size', () => {
  const summary = codegenSummary(
    'arch = sm_80\n Function kernel:\n  REG:40 STACK:0 SHARED:128 LOCAL:0\narch = sm_90\n Function kernel:\n  REG:32 STACK:0 SHARED:128 LOCAL:0',
    'arch = sm_80\n Function : kernel\n /*0000*/ ADD;\n /*0010*/ EXIT;\narch = sm_90\n Function : kernel\n /*0000*/ EXIT;',
  );
  assert.deepEqual(
    summary.map((s) => [s.architecture, s.reg, s.instructionBytes]),
    [
      ['sm_80', 40, 32],
      ['sm_90', 32, 16],
    ],
  );
});

import { z } from 'zod';
import { codexSchema, restoreOptionalFields } from '../dist/kernel/model-schema.js';
import { decisionSchema, planSchema } from '../dist/kernel/agent.js';
test('Codex wire schemas require every property and normalize optional nulls before application validation', () => {
  for (const schema of [decisionSchema, planSchema]) {
    const original = z.toJSONSchema(schema),
      wire = codexSchema(original);
    function check(node) {
      if (!node || typeof node !== 'object') return;
      if (node.properties)
        assert.deepEqual([...node.required].sort(), Object.keys(node.properties).sort());
      for (const v of Object.values(node))
        if (Array.isArray(v)) v.forEach(check);
        else check(v);
    }
    check(wire);
  }
  const original = z.toJSONSchema(decisionSchema);
  const result = restoreOptionalFields(
    {
      action: 'continue',
      stopReason: 'branch_complete',
      disposition: 'archive',
      reason: 'next',
      nextHypothesis: 'measure',
      parent: 'current',
      interpretation: null,
      uncertainties: null,
      familyClosure: null,
    },
    original,
  );
  assert.equal(decisionSchema.parse(result).familyClosure, undefined);
  assert.equal('interpretation' in result, false);
  assert.throws(() =>
    decisionSchema.parse(restoreOptionalFields({ ...result, reason: null }, original)),
  );
});

import {
  validateResearchPlan,
  registerQuestion,
  recordQuestionOutcome,
  validateResearchDecision,
} from '../dist/kernel/research.js';
const question = {
  id: 'shared-memory-boundary',
  problem: 'Does the fused algorithm fit shared memory?',
  decision: 'Use fused or split execution',
  transferableInsight: 'Shared memory formula',
  stopWhen: 'Capacity and correctness established',
  purpose: 'resource-boundary',
  justification: 'Template size determines capacity',
  measurementUse: 'feasibility',
  successAction: 'Keep fused default',
  failureAction: 'Use split fallback',
};
test('algorithm exploration rejects parameter ranking but permits resource-boundary experiments', () => {
  const root = mkdtempSync(join(tmpdir(), 'research-policy-'));
  try {
    const s = { researchMode: 'algorithm-exploration', experiment: 1 };
    const plan = {
      task: 'implement',
      familyId: 'warp',
      changeKind: 'parameter',
      researchQuestion: question,
    };
    validateResearchPlan(root, s, plan);
    assert.throws(
      () =>
        validateResearchPlan(root, s, {
          ...plan,
          researchQuestion: { ...question, purpose: 'target-tuning' },
        }),
      /不接受/,
    );
    assert.throws(
      () =>
        validateResearchPlan(root, s, {
          ...plan,
          researchQuestion: { ...question, measurementUse: 'target-ranking' },
        }),
      /不接受/,
    );
    assert.throws(
      () =>
        validateResearchPlan(root, s, {
          ...plan,
          researchQuestion: { ...question, purpose: 'structural-question' },
        }),
      /参数实验仅允许/,
    );
    validateResearchPlan(
      root,
      { ...s, researchMode: 'platform-tuning' },
      {
        ...plan,
        researchQuestion: {
          ...question,
          purpose: 'target-tuning',
          measurementUse: 'target-ranking',
        },
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('remeasure must change a structural decision and terminal questions cannot silently restart', () => {
  const root = mkdtempSync(join(tmpdir(), 'research-question-'));
  try {
    const s = { researchMode: 'algorithm-exploration', experiment: 1 },
      p = {
        task: 'diagnose',
        familyId: 'warp',
        changeKind: 'diagnostic',
        researchQuestion: question,
      };
    registerQuestion(root, s, p);
    recordQuestionOutcome(root, s, p, {
      questionOutcome: {
        status: 'deferred',
        conclusion: 'wait for A100',
        transferableFindings: [],
        targetPlatformWork: ['measure target'],
      },
    });
    assert.throws(() => validateResearchPlan(root, { ...s, experiment: 2 }, p), /重开需要/);
    validateResearchPlan(
      root,
      { ...s, experiment: 2 },
      { ...p, researchQuestion: { ...question, reopenReason: 'new structural evidence' } },
    );
    assert.throws(() => validateResearchPlan(root, s, { ...p, task: 'remeasure' }), /结构取舍/);
    assert.throws(
      () =>
        validateResearchPlan(root, s, {
          ...p,
          task: 'remeasure',
          researchQuestion: {
            ...question,
            measurementUse: 'structural-decision',
            successAction: 'retain',
            failureAction: 'retain',
          },
        }),
      /不会改变决策/,
    );
    assert.throws(() => validateResearchDecision(s, p, {}));
    // An explicitly configured boundary preserves an already-started legacy round.
    validateResearchPlan(root, { ...s, researchPolicyStart: 2 }, {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { closeFamily, validateFamilyAction } from '../dist/kernel/families.js';
test('family lifecycle is explicit, independent of campaign/question state, and guarded by verification', () => {
  const root = mkdtempSync(join(tmpdir(), 'family-action-'));
  try {
    atomic(join(root, 'families.json'), { warp: { status: 'open', experiments: [1] } });
    for (const action of ['continue', 'stop', 'pause'])
      for (const outcome of ['supported', 'deferred', 'ongoing']) {
        closeFamily(
          root,
          { familyId: 'warp' },
          { familyAction: 'close', action, questionOutcome: { status: outcome } },
          true,
          1,
        );
        assert.equal(
          JSON.parse(readFileSync(join(root, 'families.json'), 'utf8')).warp.status,
          'closed',
        );
        closeFamily(
          root,
          { familyId: 'warp' },
          { familyAction: 'keep_open', action, questionOutcome: { status: outcome } },
          true,
          1,
        );
        assert.equal(
          JSON.parse(readFileSync(join(root, 'families.json'), 'utf8')).warp.status,
          'open',
        );
      }
    assert.throws(
      () =>
        closeFamily(
          root,
          { familyId: 'warp' },
          { familyAction: 'close', action: 'stop' },
          false,
          1,
        ),
      /未通过/,
    );
    assert.equal(JSON.parse(readFileSync(join(root, 'families.json'), 'utf8')).warp.status, 'open');
    assert.throws(() => validateFamilyAction({ action: 'stop' }, true, true), /显式/);
    assert.throws(() => validateFamilyAction({ familyAction: 'close' }, false), /最终检查/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
