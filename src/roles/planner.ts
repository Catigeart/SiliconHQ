import { z } from 'zod';
import type { RoleDefinition } from './types.js';

const text = z.string().trim().min(1);
export const planSchema = z.strictObject({
  goal: text,
  steps: z
    .array(z.strictObject({ description: text, files: z.array(text), validation: text }))
    .min(1),
  acceptanceCriteria: z.array(text).min(1),
  risks: z.array(text),
});
export const plannerOutputSchema = z.toJSONSchema(planSchema);
export function plannerPrompt(task: string): string {
  return `你是开发计划制定者。只读分析项目，不修改文件、不执行实现、不启动其他智能体。输出符合给定 JSON Schema 的计划，包含目标、具体步骤、相关文件、每步验证、验收标准和风险。不要声称已完成实现或测试。以下是用户需求：\n${task}`;
}

export const plannerRole: RoleDefinition = {
  artifactName: 'plan.json',
  label: '计划已校验',
  sandboxMode: 'read-only',
  outputSchema: plannerOutputSchema,
  buildPrompt: (context) => plannerPrompt(context.instruction),
  parseResult: (answer) => ({ artifact: planSchema.parse(JSON.parse(answer)) }),
};
