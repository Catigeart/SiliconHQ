import { z } from 'zod';
import { planSchema } from './planner.js';
import type { RoleDefinition } from './types.js';

const text = z.string().trim().min(1);
export const implementationSchema = z.strictObject({
  summary: text,
  outcome: z.enum(['implemented', 'incomplete']),
  changes: z.array(z.strictObject({ path: text, description: text })),
  validations: z.array(
    z.strictObject({
      command: text,
      result: z.enum(['passed', 'failed', 'not_run']),
      evidence: text,
    }),
  ),
  remaining: z.array(text),
});
export const implementationOutputSchema = z.toJSONSchema(implementationSchema);

export const planSnapshotSchema = z.object({
  originalRequirement: z.string().trim().min(1),
  plan: planSchema,
});

export function developerPrompt(snapshot: unknown, instruction: string): string {
  planSnapshotSchema.parse(snapshot);
  return `你是代码实现者。根据下面原始需求和计划快照完成实现并执行相关验证。保护用户已有改动，不自动提交，不启动其他智能体。仅修改工作区内完成任务所需文件。无法完成时明确报告 incomplete 和剩余工作，不伪造验证结果。输出符合 schema 的实现报告；implemented 仅代表实现者自述，不代表独立验收通过。\n计划快照：\n${JSON.stringify(snapshot)}\n本轮指令：\n${instruction}`;
}

export const developerRole: RoleDefinition = {
  artifactName: 'implementation.json',
  snapshotFile: 'plan-snapshot.json',
  gitBaseline: 'git-before',
  label: '实现报告（尚未独立验收）',
  sandboxMode: 'workspace-write',
  outputSchema: implementationOutputSchema,
  buildPrompt: (context) => developerPrompt(context.snapshot, context.instruction),
  parseResult: (answer) => {
    const report = implementationSchema.parse(JSON.parse(answer));
    return { artifact: report, outcome: report.outcome };
  },
};
