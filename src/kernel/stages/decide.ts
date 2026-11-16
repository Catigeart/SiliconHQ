import { existsSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readEvidence } from '../artifacts.js';
import { reached } from '../budget.js';
import { closeFamily, validateClosure } from '../families.js';
import { writeExperimentReport, writeResearchIndex } from '../reports.js';
import { recordQuestionOutcome } from '../research.js';
import { type SanitizerEvidence } from '../sanitizer.js';
import { atomic, manifest, readJson } from '../store.js';

import { same } from '../runtime-types.js';
import type { StageContext, StageResult } from '../stage-context.js';
export async function handleDecide(context: StageContext): Promise<StageResult> {
  const { s, store, root, experimentDir, work, decisionModel, transition, check, snapshot } =
    context;

  const final = existsSync(join(experimentDir(), 'final-check.json'))
    ? readEvidence(join(experimentDir(), 'final-check.json'))
    : undefined;
  const review = existsSync(join(experimentDir(), 'final_review.json'))
    ? readJson(join(experimentDir(), 'final_review.json'))
    : undefined;
  const numericalEligible = Boolean(
    final?.passed && review?.verdict === 'passed' && same(final.source, manifest(work())),
  );
  const sanitizerReport = existsSync(join(experimentDir(), 'sanitizer.json'))
    ? (readJson(join(experimentDir(), 'sanitizer.json')) as SanitizerEvidence)
    : undefined;
  const sanitizerStatus = sanitizerReport?.status ?? 'not_run';
  if (sanitizerReport && !same(sanitizerReport.source, manifest(work())))
    throw new Error('sanitizer 源码哈希不匹配');
  const eligible =
    numericalEligible && !['failed', 'blocked', 'cancelled'].includes(sanitizerStatus);
  const representativeFailure = readdirSync(experimentDir())
    .filter((f) => /^representative-\d+\.json$/.test(f))
    .some((f) => readJson(join(experimentDir(), f)).status !== 'passed');
  const familyVerificationPassed =
    numericalEligible &&
    sanitizerStatus === 'passed' &&
    !representativeFailure &&
    s.profile === 'full';
  const baseline = readEvidence(join(root, 'baseline-evidence/evidence.json'));
  const parentEvidenceFile = join(s.parent, '..', 'final-check.json');
  const parentEvidence = existsSync(parentEvidenceFile)
    ? readEvidence(parentEvidenceFile)
    : baseline;
  const comparison = (final?.performance ?? []).map((item: any) => {
    const base = baseline.performance.find(
      (v) =>
        v.n === item.n &&
        v.nrhs === item.nrhs &&
        v.nb === item.nb &&
        v.blocks === item.blocks &&
        v.uplo === item.uplo &&
        v.diag === item.diag,
    );
    const parent = parentEvidence.performance?.find(
      (v: any) =>
        v.n === item.n &&
        v.nrhs === item.nrhs &&
        v.nb === item.nb &&
        v.blocks === item.blocks &&
        v.uplo === item.uplo &&
        v.diag === item.diag,
    );
    return {
      ...item,
      baselineUs: base?.medianUs,
      speedup: base ? base.medianUs / item.medianUs : null,
      parentUs: parent?.medianUs,
      parentSpeedup: parent ? parent.medianUs / item.medianUs : null,
    };
  });
  atomic(join(experimentDir(), 'comparison.json'), {
    eligible,
    localValidationPassed: numericalEligible && s.profile === 'full',
    sanitizerStatus,
    familyVerificationPassed,
    comparison,
    baseline: 'sm_120 local only',
    targetRuntimeVerified: false,
  });
  const decisionKind = s.stage === 'family_decide' ? 'family_decide' : 'decide';
  const decision = await decisionModel(
    decisionKind,
    `基于本轮代码、正确性及性能结果决定继续、暂停或结束。eligible=${eligible}，profile=${s.profile}。只有 eligible 才允许 retain。parent=current 要求数值与审阅通过，sanitizer 检出缺陷时只允许明确继续修复，不能提升为通过方案。较慢但正确的方案可 archive。给出具体下一步假设；下一轮规划将读到该决策。不得突破预算。timeOnly=${Boolean(s.timeOnly)}。单个分支完成用 stopReason=branch_complete；全局收敛才用 goal_converged，环境受阻用 environment_blocked，明确人工停止用 user_requested。sanitizerPolicy=${s.sanitizerPolicy ?? 'disabled'}，sanitizerStatus=${sanitizerStatus}。sanitizerPolicy 启用时，算法族准备结束探索用 action=finalize_family，先请求控制器最终检查；disabled 时沿用旧流程，不请求该动作。family_decide 阶段根据 sanitizer.json 反馈决定继续修复、暂停或结束，不得再次请求 finalize_family。检查失败不得 retain 或宣称 goal_converged；可 archive/reject 并 continue、parent=current 来修复当前候选，或 parent=baseline 另选算法。最终反馈必须给出 familyAction=close/keep_open；action=continue 可以同时关闭当前族并继续全局研究。`,
    numericalEligible && sanitizerStatus === 'passed' && !representativeFailure,
  );
  const repair =
    numericalEligible &&
    sanitizerStatus === 'failed' &&
    decision.action === 'continue' &&
    decision.disposition !== 'retain';
  if (
    !eligible &&
    (decision.disposition === 'retain' || (decision.parent === 'current' && !repair))
  ) {
    rmSync(join(experimentDir(), decisionKind + '.json'));
    throw new Error('planner 试图提升未通过验证的候选');
  }
  if (
    decisionKind === 'family_decide' &&
    (decision.action === 'finalize_family' ||
      ((sanitizerStatus !== 'passed' || representativeFailure) &&
        decision.stopReason === 'goal_converged'))
  ) {
    rmSync(join(experimentDir(), decisionKind + '.json'));
    throw new Error('最终检查未通过不能宣称收敛，且不得重复请求同轮最终检查');
  }
  const plan = existsSync(join(experimentDir(), 'plan.json'))
    ? readJson(join(experimentDir(), 'plan.json'))
    : undefined;
  const finishRequested =
    decision.action === 'finalize_family' ||
    (decision.action === 'stop' && decision.stopReason === 'goal_converged');
  if (decisionKind === 'decide' && finishRequested && s.sanitizerPolicy && numericalEligible) {
    try {
      validateClosure(root, s, plan, decision);
    } catch (error) {
      rmSync(join(experimentDir(), decisionKind + '.json'), { force: true });
      throw error;
    }
    atomic(join(experimentDir(), 'finalize-request.json'), decision);
    snapshot('final-candidate');
    transition('sanitizer');
    return 'continue';
  }
  if (decision.action === 'finalize_family') {
    rmSync(join(experimentDir(), decisionKind + '.json'));
    throw new Error('只有通过数值与审阅且启用 sanitizer 的候选可请求算法族最终验证');
  }
  snapshot('archived');
  if (decisionKind === 'family_decide') {
    const request = readJson(join(experimentDir(), 'finalize-request.json'));
    closeFamily(
      root,
      plan,
      { ...decision, familyClosure: request.familyClosure },
      numericalEligible && sanitizerStatus === 'passed' && !representativeFailure,
      s.experiment,
    );
  }
  if (!s.results.some((r) => r.experiment === s.experiment))
    s.results.push({ experiment: s.experiment, eligible, path: experimentDir(), decision });
  recordQuestionOutcome(root, s, readJson(join(experimentDir(), 'plan.json')), decision);
  writeExperimentReport(root, s.experiment);
  writeResearchIndex(root, s);
  store.event(s, 'experiment.archived', { eligible, decision });
  s.parent =
    decision.parent === 'current' ? join(experimentDir(), 'archived') : join(root, 'baseline');
  if (decision.action === 'stop' && !(s.timeOnly && decision.stopReason === 'branch_complete')) {
    s.status = decision.stopReason === 'environment_blocked' ? 'blocked' : 'completed';
    return 'stop';
  }
  if (reached(s.experiment, s.budget.experiments)) {
    s.status = 'budget_exhausted';
    return 'stop';
  }
  s.experiment++;
  transition('plan');
  if (decision.action === 'pause') {
    s.status = 'paused';
    return 'stop';
  }
}
