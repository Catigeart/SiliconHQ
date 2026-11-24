import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { reached } from '../budget.js';
import { closeFamily } from '../families.js';
import { writeExperimentReport, writeResearchIndex } from '../reports.js';
import { recordQuestionOutcome } from '../research.js';
import { readJson } from '../store.js';

import type { StageContext, StageResult } from '../stage-context.js';
export async function handleArchiveFamilyDecide(context: StageContext): Promise<StageResult> {
  const { s, store, root, experimentDir, decisionModel, transition } = context;

  const plan = readJson(join(experimentDir(), 'plan.json')),
    validation = readJson(join(experimentDir(), 'family-validation.json'));
  const decision = await decisionModel(
    'family_decide',
    '本轮仅整理既有算法族与验证其归档代表，没有产生新代码候选。根据 family-validation.json 与代表报告给出 questionOutcome。disposition=archive、parent=current，不再请求 finalize_family；通过后明确结束当前算法族，继续提出算法/布局/融合等结构问题。失败时制定修复或搁置，不得宣称全局完成。移植说明以 plan.finalization.portingGuide 为基础，不要求 sm_120 参数最优。familyAction 明确表示本族关闭或保持开放，与整个任务的 action 独立。',
    validation.passed,
  );
  if (
    decision.action === 'finalize_family' ||
    decision.disposition !== 'archive' ||
    decision.parent !== 'current' ||
    (!validation.passed && decision.stopReason === 'goal_converged')
  ) {
    rmSync(join(experimentDir(), 'family_decide.json'), { force: true });
    throw new Error('归档算法族决策无效或验证失败却宣称完成');
  }
  closeFamily(
    root,
    plan,
    { ...decision, familyClosure: plan.finalization },
    validation.passed,
    s.experiment,
  );
  recordQuestionOutcome(root, s, plan, decision);
  if (!s.results.some((r) => r.experiment === s.experiment))
    s.results.push({ experiment: s.experiment, eligible: false, path: experimentDir(), decision });
  writeExperimentReport(root, s.experiment);
  writeResearchIndex(root, s);
  store.event(s, 'family.finalized', { familyId: plan.familyId, validation, decision });
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
