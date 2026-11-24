import { z } from 'zod';
import { implementationSchema, planSnapshotSchema } from './developer.js';
import type { RoleDefinition } from './types.js';

const text = z.string().trim().min(1);
const finding = z.strictObject({
  severity: z.enum(['high', 'medium', 'low']),
  location: text,
  problem: text,
  evidence: text,
  requestedChange: text,
});
export type ReviewPolicy = 'strict' | 'blocking';
export const blockingInstructions =
  '按阻塞级别验收：P0 是隐蔽的严重错误，P1 是用户可见的功能错误，写入 findings。P2（维护成本或未来风险）和 P3（改进偏好）只写入 suggestions，保留位置、证据和建议。核对约定的真实入口；必要证据缺失时标记 not_verified 或 not_run。复核时优先核对上轮阻塞项和相关回归，仍逐项核对验收标准。';
export const reviewSchema = z.strictObject({
  verdict: z.enum(['passed', 'changes_requested', 'blocked']),
  summary: text,
  criteria: z
    .array(
      z.strictObject({
        criterion: text,
        result: z.enum(['passed', 'failed', 'not_verified']),
        evidence: text,
      }),
    )
    .min(1),
  findings: z
    .array(finding)
    .describe(
      '仅列出有证据的实现缺陷。verdict 为 blocked 时返回空数组；缺少运行轨迹等验证限制记在 limitations。',
    ),
  checks: z.array(
    z.strictObject({
      command: text,
      result: z.enum(['passed', 'failed', 'not_run']),
      evidence: text,
    }),
  ),
  limitations: z.array(text),
});
export const blockingReviewSchema = reviewSchema.extend({
  findings: z.array(finding.extend({ severity: z.enum(['P0', 'P1']) })),
  suggestions: z.array(finding.extend({ severity: z.enum(['P2', 'P3']) })),
});
export function recheckInstructions(previous: unknown): string {
  const { findings, criteria, checks } = blockingReviewSchema.parse(previous);
  const openCriteria = criteria.filter((c) => c.result !== 'passed');
  const openChecks = checks.filter((c) => c.result !== 'passed');
  if (!findings.length && !openCriteria.length && !openChecks.length) return '';
  return (
    '\n上次审查阻塞项与待复验事项：' +
    JSON.stringify({ findings, criteria: openCriteria, checks: openChecks })
  );
}

export const reviewOutputSchema = z.toJSONSchema(reviewSchema);
export const reviewSnapshotSchema = z.object({
  sourceImplementationId: text,
  planSnapshot: planSnapshotSchema,
  implementation: implementationSchema,
});
export function reviewerPrompt(
  snapshot: unknown,
  git: unknown,
  instruction: string,
  policy: ReviewPolicy = 'strict',
): string {
  reviewSnapshotSchema.parse(snapshot);
  const raw = JSON.stringify(snapshot);
  return `你是独立代码检查者。对照原始需求和计划快照，读取实际代码并执行适合的只读验证。实现者报告只是待核实的主张。不得修改代码、修复问题、提交或启动其他智能体。区分原有 Git 改动，不将所有工作区变化归因于实现者。检查对象是当前工作区，不是冻结提交。逐项返回所有验收标准，criterion 必须逐字复制。每个问题需具体位置、证据和修复要求。测试因只读权限、依赖或环境无法执行时记 not_run，相关标准 not_verified，不能声称通过。${policy === 'blocking' ? blockingInstructions : '有明确缺陷用 changes_requested；无明确缺陷但证据不足用 blocked；只有全部标准已验证、无待修问题和未运行检查时才可 passed。'}输出指定 JSON 报告。\n需求、计划、实现报告与原有改动快照：\n${raw}\n当前 Git：\n${JSON.stringify(git)}\n本轮指令：\n${instruction}`;
}
export function validateReview(
  answer: string,
  inputSnapshot: unknown,
  policy: ReviewPolicy = 'strict',
) {
  const snapshot = reviewSnapshotSchema.parse(inputSnapshot);
  return validateCriteriaReview(answer, snapshot.planSnapshot.plan.acceptanceCriteria, policy);
}
export function validateCriteriaReview(
  answer: string,
  criteria: string[],
  policy: ReviewPolicy = 'strict',
) {
  const report = (policy === 'blocking' ? blockingReviewSchema : reviewSchema).parse(
    JSON.parse(answer),
  );
  const expected = [...criteria].sort();
  const actual = report.criteria.map((item) => item.criterion).sort();
  if (JSON.stringify(expected) !== JSON.stringify(actual))
    throw new Error('检查报告未完整覆盖计划验收标准');
  if (policy === 'blocking') {
    if (
      report.findings.length ||
      report.criteria.some((c) => c.result === 'failed') ||
      report.checks.some((c) => c.result === 'failed')
    )
      report.verdict = 'changes_requested';
    else if (
      report.verdict === 'blocked' ||
      report.criteria.some((c) => c.result === 'not_verified') ||
      report.checks.some((c) => c.result === 'not_run')
    )
      report.verdict = 'blocked';
    else if (
      report.verdict === 'changes_requested' &&
      !('suggestions' in report && report.suggestions.length)
    )
      throw new Error('审查要求修改但未给出具体缺陷');
    else report.verdict = 'passed';
    return report;
  }
  if (
    report.verdict === 'changes_requested' &&
    !report.findings.length &&
    !report.criteria.some((item) => item.result === 'failed')
  )
    throw new Error('审查要求修改但未给出具体缺陷');
  if (
    report.verdict === 'passed' &&
    (report.criteria.some((item) => item.result !== 'passed') ||
      report.findings.length ||
      report.checks.some((item) => item.result !== 'passed'))
  )
    throw new Error('检查报告的通过结论与证据状态矛盾');
  if (
    report.verdict === 'blocked' &&
    (report.criteria.some((item) => item.result === 'failed') || report.findings.length)
  )
    throw new Error(
      '审查报告字段冲突：blocked 需要 findings 为空且没有 failed 标准。请将缺少的证据记入 limitations；若能证明实现有缺陷，请返回 changes_requested。',
    );
  return report;
}

function reviewRole(policy: ReviewPolicy): RoleDefinition {
  return {
    artifactName: 'review.json',
    snapshotFile: 'review-snapshot.json',
    gitBaseline: 'git-review',
    label: '检查报告',
    sandboxMode: 'read-only',
    outputSchema: policy === 'blocking' ? z.toJSONSchema(blockingReviewSchema) : reviewOutputSchema,
    buildPrompt: (context) =>
      reviewerPrompt(context.snapshot, context.git, context.instruction, policy),
    parseResult: (answer, context) => {
      const report = validateReview(answer, context.snapshot, policy);
      return { artifact: report, verdict: report.verdict };
    },
  };
}
export const reviewerRole = reviewRole('strict');
export const blockingReviewerRole = reviewRole('blocking');
