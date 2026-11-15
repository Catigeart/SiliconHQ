import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { validateResearchClosure } from './research.js';
import { atomic, manifest, readJson, type State } from './store.js';
export function registerFamily(root: string, s: State, plan: any) {
  if (
    !plan.familyId ||
    plan.task === 'diagnose' ||
    plan.task === 'remeasure' ||
    plan.task === 'finalize_family'
  )
    return;
  const file = join(root, 'families.json'),
    families = existsSync(file) ? readJson(file) : {};
  const old = families[plan.familyId];
  if (old?.status === 'closed' && !plan.reopenReason)
    throw new Error('已关闭算法族需要 reopenReason');
  const parentPlan = join(s.parent, '..', 'plan.json');
  if (existsSync(parentPlan)) {
    const parent = readJson(parentPlan);
    if (parent.familyId && parent.familyId !== plan.familyId && !plan.familyChangeReason)
      throw new Error('切换算法族需要 familyChangeReason；参数变体应沿用父族');
  }
  families[plan.familyId] = {
    ...old,
    name: plan.algorithmFamily,
    status: 'open',
    experiments: [...new Set([...(old?.experiments ?? []), s.experiment])],
    reopenReason: plan.reopenReason,
  };
  atomic(file, families);
}
export function validateClosure(root: string, s: State, plan: any, decision: any) {
  // Already-running legacy stages may finish without rewriting their frozen plan.
  if (!plan?.familyId) return;
  const c = decision.familyClosure;
  validateResearchClosure(s, c);
  if (
    !c?.completedHypotheses?.length ||
    !c.reason ||
    !c.representatives?.some((r: any) => r.experiment === s.experiment)
  )
    throw new Error('算法族结束必须说明完成/搁置假设，并包含当前候选代表');
  if (new Set(c.representatives.map((r: any) => r.experiment)).size !== c.representatives.length)
    throw new Error('算法族代表重复');
  for (const r of c.representatives) {
    const dir = join(root, 'experiments', String(r.experiment));
    if (
      r.experiment > s.experiment ||
      !existsSync(join(dir, 'plan.json')) ||
      readJson(join(dir, 'plan.json')).familyId !== plan.familyId
    )
      throw new Error('代表必须属于当前算法族');
    if (
      r.experiment !== s.experiment &&
      (!existsSync(join(dir, 'archived')) || !readJson(join(dir, 'comparison.json')).eligible)
    )
      throw new Error('历史代表必须已归档且数值和审阅通过');
  }
}
export function validateFamilyAction(decision: any, finalFeedback: boolean, verified?: boolean) {
  if (!finalFeedback) {
    if (decision.familyAction === 'close') throw new Error('只有最终检查反馈阶段可以关闭算法族');
    return;
  }
  if (!['close', 'keep_open'].includes(decision.familyAction))
    throw new Error(
      '最终反馈必须显式给出 familyAction=close 或 keep_open，不能由 action/questionOutcome 推断',
    );
  if (decision.familyAction === 'close' && !verified)
    throw new Error('代表验证未通过，不能关闭算法族；使用 keep_open 制定修复或搁置');
}
export function closeFamily(
  root: string,
  plan: any,
  decision: any,
  verified: boolean,
  validationRound?: number,
) {
  validateFamilyAction(decision, true, verified);
  if (!plan?.familyId) return;
  const file = join(root, 'families.json'),
    families = existsSync(file) ? readJson(file) : {};
  const old = families[plan.familyId];
  if (!old) return;
  families[plan.familyId] = {
    ...old,
    status: decision.familyAction === 'close' ? 'closed' : 'open',
    familyAction: decision.familyAction,
    representativesVerified: verified,
    validationRound,
    closure: decision.familyClosure ?? old.closure,
  };
  atomic(file, families);
}

// Finalize existing archives without fabricating a new implementation round.
export function validateArchivedFinalization(root: string, s: State, plan: any) {
  const familiesFile = join(root, 'families.json');
  if (
    existsSync(familiesFile) &&
    readJson(familiesFile)[plan.familyId]?.status === 'closed' &&
    !plan.reopenReason
  )
    throw new Error('算法族已完成；复用其说明，不重复最终验证；新证据重开需要 reopenReason');
  const closure = plan.finalization;
  if (!closure?.representatives?.length || !closure.completedHypotheses?.length || !closure.reason)
    throw new Error('归档算法族收尾需要 finalization 和代表候选');
  if (
    new Set(closure.representatives.map((r: any) => r.experiment)).size !==
    closure.representatives.length
  )
    throw new Error('代表候选重复');
  for (const rep of closure.representatives) {
    const dir = join(root, 'experiments', String(rep.experiment));
    if (rep.experiment >= s.experiment || !existsSync(join(dir, 'archived')))
      throw new Error('收尾只能选择已有归档候选');
    const p = readJson(join(dir, 'plan.json')),
      c = readJson(join(dir, 'comparison.json')),
      e = readJson(join(dir, 'final-check.json')),
      review = readJson(join(dir, 'final_review.json'));
    if (p.familyId !== plan.familyId) throw new Error('代表候选必须属于同一算法族');
    if (
      !c.localValidationPassed ||
      !e.passed ||
      review.verdict !== 'passed' ||
      JSON.stringify(e.source) !== JSON.stringify(manifest(join(dir, 'archived')))
    )
      throw new Error('代表候选缺少匹配源码的 full 正确性和审阅证据');
  }
}
