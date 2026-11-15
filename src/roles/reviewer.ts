import { z } from 'zod';
import { implementationSchema, planSnapshotSchema } from './developer.js';
import type { RoleDefinition } from './types.js';

const text = z.string().trim().min(1);
export const reviewSchema = z.strictObject({
  verdict: z.enum(['passed', 'changes_requested', 'blocked']),
  summary: text,
  criteria: z.array(z.strictObject({ criterion: text, result: z.enum(['passed','failed','not_verified']), evidence: text })).min(1),
  findings: z.array(z.strictObject({ severity: z.enum(['high','medium','low']), location: text, problem: text, evidence: text, requestedChange: text })),
  checks: z.array(z.strictObject({ command: text, result: z.enum(['passed','failed','not_run']), evidence: text })),
  limitations: z.array(text),
});
export const reviewOutputSchema = z.toJSONSchema(reviewSchema);
export const reviewSnapshotSchema = z.object({
  sourceImplementationId: text,
  planSnapshot: planSnapshotSchema,
  implementation: implementationSchema,
});
export function reviewerPrompt(snapshot: unknown, git: unknown, instruction: string): string {
  reviewSnapshotSchema.parse(snapshot);
  const raw = JSON.stringify(snapshot);
  return `你是独立代码检查者。对照原始需求和计划快照，读取实际代码并执行适合的只读验证。实现者报告只是待核实的主张。不得修改代码、修复问题、提交或启动其他智能体。区分原有 Git 改动，不将所有工作区变化归因于实现者。检查对象是当前工作区，不是冻结提交。逐项返回所有验收标准，criterion 必须逐字复制。每个问题需具体位置、证据和修复要求。测试因只读权限、依赖或环境无法执行时记 not_run，相关标准 not_verified，不能声称通过。有明确缺陷用 changes_requested；无明确缺陷但证据不足用 blocked；只有全部标准已验证、无待修问题和未运行检查时才可 passed。输出指定 JSON 报告。\n需求、计划、实现报告与原有改动快照：\n${raw}\n当前 Git：\n${JSON.stringify(git)}\n本轮指令：\n${instruction}`;
}
export function validateReview(answer: string, inputSnapshot: unknown) {
  const report = reviewSchema.parse(JSON.parse(answer));
  const snapshot = reviewSnapshotSchema.parse(inputSnapshot);
  const expected = [...snapshot.planSnapshot.plan.acceptanceCriteria].sort();
  const actual = report.criteria.map(item=>item.criterion).sort();
  if (JSON.stringify(expected)!==JSON.stringify(actual)) throw new Error('检查报告未完整覆盖计划验收标准');
  if (report.verdict==='passed' && (report.criteria.some(item=>item.result!=='passed') || report.findings.length || report.checks.some(item=>item.result!=='passed'))) throw new Error('检查报告的通过结论与证据状态矛盾');
  if (report.verdict==='blocked' && (report.criteria.some(item=>item.result==='failed') || report.findings.length)) throw new Error('已有明确缺陷，应返回 changes_requested');
  return report;
}

export const reviewerRole: RoleDefinition = {
  artifactName: 'review.json',
  snapshotFile: 'review-snapshot.json',
  gitBaseline: 'git-review',
  label: '检查报告',
  sandboxMode: 'read-only',
  outputSchema: reviewOutputSchema,
  buildPrompt: context => reviewerPrompt(context.snapshot, context.git, context.instruction),
  parseResult: (answer, context) => {
    const report = validateReview(answer, context.snapshot);
    return { artifact: report, verdict: report.verdict };
  },
};
