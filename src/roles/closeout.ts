import { z } from 'zod';
import { planSnapshotSchema, implementationSchema } from './developer.js';
import { reviewSchema } from './reviewer.js';
import type { RoleDefinition } from './types.js';

const text = z.string().trim().min(1);
export const failureContextSchema = z.object({
  originalRequirement: text,
  planSnapshot: planSnapshotSchema,
  implementation: implementationSchema,
  finalReviewRunId: text,
  finalReview: reviewSchema,
  repairCount: z.number().int().nonnegative(),
  maxRepairs: z.number().int().nonnegative(),
});
export const developerFeedbackSchema = z.strictObject({
  summary: text,
  completedWork: z.array(text),
  remainingIssues: z.array(z.strictObject({
    issue: text, evidence: text, reason: text,
    attemptedFixes: z.array(text), nextStep: text,
  })).min(1),
  needsUserInput: z.array(text),
});
export const finalSummarySchema = z.strictObject({
  status: z.literal('repair_limit_reached'),
  summary: text,
  completedWork: z.array(text),
  remainingIssues: z.array(z.strictObject({ issue: text, evidence: text, impact: text })).min(1),
  reasonForStopping: text,
  nextSteps: z.array(text).min(1),
  needsUserInput: z.array(text),
});
export const summaryContextSchema = failureContextSchema.extend({ developerFeedback: developerFeedbackSchema });

export const developerFeedbackRole: RoleDefinition = {
  artifactName: 'developer-feedback.json',
  snapshotFile: 'failure-context.json',
  label: '开发者失败分析',
  sandboxMode: 'read-only',
  displayMessages: false,
  outputSchema: z.toJSONSchema(developerFeedbackSchema),
  buildPrompt(context) {
    failureContextSchema.parse(context.snapshot);
    return `你是原任务的 developer。现在进入失败收尾分析，修复预算已耗尽。只读检查，禁止继续修改代码、重试修复、提交或调用其他智能体。根据原需求、固定计划、实现记录和最后一次 terra 检查，向 planner 解释已完成工作、每个遗留问题及证据、已尝试的修复、仍失败的原因与下一步建议。原因不确定时明确标注推测，不掩盖问题、不宣称通过，不遗漏检查中的失败验收项或 findings。输出规定格式的 developer 反馈。\n${JSON.stringify(context.snapshot)}\n本轮指令：${context.instruction}`;
  },
  parseResult: answer => ({ artifact: developerFeedbackSchema.parse(JSON.parse(answer)) }),
};

export const plannerSummaryRole: RoleDefinition = {
  artifactName: 'final-summary.json',
  snapshotFile: 'summary-context.json',
  label: '规划者最终说明',
  sandboxMode: 'read-only',
  displayMessages: false,
  outputSchema: z.toJSONSchema(finalSummarySchema),
  buildPrompt(context) {
    summaryContextSchema.parse(context.snapshot);
    return `你是原任务的 planner。现在向用户汇总开发流程的最终失败情况。修复预算已耗尽，不再制定并执行新一轮修复，不修改文件、不提交、不调用其他智能体。根据原需求、计划、最后一次 review 和 developer 反馈，用清楚的中文说明：完成了什么、仍未解决的问题及具体证据与影响、为什么停止、建议下一步以及需要用户提供什么信息。区分验证事实和 developer 的推测，不能把失败包装成通过，不能遗漏已知问题。输出指定格式的最终报告，status 必须为 repair_limit_reached。\n${JSON.stringify(context.snapshot)}\n本轮指令：${context.instruction}`;
  },
  parseResult: answer => ({ artifact: finalSummarySchema.parse(JSON.parse(answer)) }),
};

export function renderFinalSummary(value: unknown): string {
  const report = finalSummarySchema.parse(value);
  const bullets = (items: string[]) => items.length ? items.map(item => `- ${item}`).join('\n') : '- 无';
  return [
    '任务未通过验收：自动修复次数已用尽。', report.summary,
    '已完成：', bullets(report.completedWork),
    '尚未解决：', report.remainingIssues.map((item, i) => `${i + 1}. ${item.issue}\n   证据：${item.evidence}\n   影响：${item.impact}`).join('\n'),
    '停止原因：', report.reasonForStopping,
    '建议下一步：', bullets(report.nextSteps),
    '需要你提供的信息：', bullets(report.needsUserInput),
  ].join('\n\n') + '\n';
}
