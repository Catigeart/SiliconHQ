import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { atomic, readJson, type State } from './store.js';
const text = z.string().min(1);
export const researchModeSchema = z.enum(['algorithm-exploration', 'platform-tuning']);
export const changeKindSchema = z.enum([
  'algorithm',
  'layout',
  'fusion',
  'parameter',
  'correctness',
  'diagnostic',
]);
export const questionSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
  problem: text,
  decision: text,
  transferableInsight: text,
  stopWhen: text,
  purpose: z.enum([
    'structural-question',
    'default-instance',
    'resource-boundary',
    'algorithm-hypothesis',
    'target-tuning',
    'family-finalization',
  ]),
  justification: text,
  measurementUse: z.enum(['feasibility', 'structural-decision', 'target-ranking']),
  successAction: text,
  failureAction: text,
  reopenReason: text.optional(),
});
export const outcomeSchema = z.strictObject({
  status: z.enum(['ongoing', 'supported', 'rejected', 'deferred']),
  conclusion: text,
  transferableFindings: z.array(text),
  targetPlatformWork: z.array(text),
});
export const portingGuideSchema = z.strictObject({
  algorithmSummary: text,
  defaultConfiguration: z.array(text).min(1),
  parameterConstraints: z.array(text).min(1),
  resourceNotes: z.array(text).min(1),
  portableFindings: z.array(text),
  targetPlatformWork: z.array(text).min(1),
  abandonedDirections: z.array(text),
});
export function policyApplies(s: State) {
  return Boolean(s.researchMode && s.experiment >= (s.researchPolicyStart ?? 1));
}
export function questions(root: string): Record<string, any> {
  const f = join(root, 'questions.json');
  return existsSync(f) ? readJson(f) : {};
}
export function validateResearchPlan(root: string, s: State, plan: any) {
  if (!policyApplies(s)) return;
  const kind = changeKindSchema.parse(plan.changeKind),
    q = questionSchema.parse(plan.researchQuestion);
  if (['diagnose', 'remeasure', 'finalize_family'].includes(plan.task) && kind !== 'diagnostic')
    throw new Error('只读研究任务 changeKind 必须为 diagnostic');
  if (plan.task === 'implement' && kind === 'diagnostic') throw new Error('实现任务不能伪装成诊断');
  if (s.researchMode === 'algorithm-exploration') {
    if (q.purpose === 'target-tuning' || q.measurementUse === 'target-ranking')
      throw new Error('算法探索模式不接受本机参数排名/最优配置搜索；将其归档为目标平台待调事项');
    if (
      kind === 'parameter' &&
      !['default-instance', 'resource-boundary', 'algorithm-hypothesis'].includes(q.purpose)
    )
      throw new Error('参数实验仅允许建立默认实例、验证资源边界或检验明确的算法假设');
    if (plan.task === 'remeasure' && q.measurementUse !== 'structural-decision')
      throw new Error('整体复测必须服务于结构取舍，不能只确认几个百分点的本机收益');
    if (plan.task === 'remeasure' && q.successAction.trim() === q.failureAction.trim())
      throw new Error('测量结果不会改变决策，无需继续复测');
  }
  const previous = questions(root)[q.id];
  if (previous && previous.familyId !== plan.familyId)
    throw new Error('questionId 已属于其他算法族');
  if (previous && previous.status !== 'ongoing' && !q.reopenReason)
    throw new Error('研究问题已经收敛或搁置；新证据重开需要 reopenReason');
  if (plan.task === 'finalize_family') validateResearchClosure(s, plan.finalization);
}
export function registerQuestion(root: string, s: State, plan: any) {
  if (!policyApplies(s)) return;
  const all = questions(root),
    q = plan.researchQuestion,
    old = all[q.id];
  all[q.id] = {
    ...old,
    id: q.id,
    familyId: plan.familyId,
    question: old?.question ?? q,
    status: 'ongoing',
    experiments: [...new Set([...(old?.experiments ?? []), s.experiment])],
    history: [
      ...(old?.history ?? []).filter((e: any) => e.experiment !== s.experiment),
      { experiment: s.experiment, task: plan.task, changeKind: plan.changeKind, question: q },
    ],
  };
  atomic(join(root, 'questions.json'), all);
}
export function validateResearchDecision(s: State, plan: any, decision: any) {
  if (!policyApplies(s) || !plan?.researchQuestion) return;
  outcomeSchema.parse(decision.questionOutcome);
}
export function recordQuestionOutcome(root: string, s: State, plan: any, decision: any) {
  if (!plan?.researchQuestion || !decision.questionOutcome) return;
  const all = questions(root),
    record = all[plan.researchQuestion.id];
  if (!record) return;
  const outcome = outcomeSchema.parse(decision.questionOutcome);
  record.status = outcome.status;
  record.outcome = outcome;
  record.evidenceRound = s.experiment;
  record.outcomes = [
    ...(record.outcomes ?? []).filter((o: any) => o.experiment !== s.experiment),
    { experiment: s.experiment, ...outcome },
  ];
  atomic(join(root, 'questions.json'), all);
}
export function validateResearchClosure(s: State, closure: any) {
  if (policyApplies(s) && s.researchMode === 'algorithm-exploration') {
    if (!closure?.completedHypotheses?.length || !closure?.reason)
      throw new Error('算法族收尾须给出已完成假设与结束理由');
    portingGuideSchema.parse(closure.portingGuide);
  }
}
