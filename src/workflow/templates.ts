import { z } from 'zod';
import { defaultNodeRepairs, defaultRepairBudget, stepGraphIssues } from './rules.js';

const key = z.string().trim().min(1).max(80);
export const verificationSchema = z.strictObject({
  argv: z
    .array(
      z
        .string()
        .max(32768)
        .refine((arg) => !arg.includes('\0'), '参数不能包含 NUL'),
    )
    .min(1)
    .max(256)
    .refine((args) => !!args[0]?.trim(), '请填写要运行的程序'),
  timeoutMs: z.number().int().min(1000).max(3600000).default(120000),
});
const nodeSchema = z.strictObject({
  id: key,
  name: key,
  kind: z.enum(['plan', 'develop', 'review', 'read', 'approval', 'verify']),
  instructions: z.string().trim().min(1),
  currentDiff: z.boolean().optional(),
  reviewPolicy: z.enum(['strict', 'blocking']).optional(),
  backend: key,
  model: z.string().trim().optional(),
  provider: z.string().trim().optional(),
  reasoningEffort: z.string().trim().optional(),
  verification: verificationSchema.optional(),
  inputs: z.array(key).default([]),
  parallelGroup: key.optional(),
  when: z
    .strictObject({
      source: key,
      equals: z.enum([
        'passed',
        'changes_requested',
        'blocked',
        'implemented',
        'incomplete',
        'failed',
      ]),
    })
    .optional(),
  returnTo: key.optional(),
  maxRepairs: z.number().int().min(0).max(defaultRepairBudget).default(defaultNodeRepairs),
});

export const workflowTemplateSchema = z
  .strictObject({
    id: key,
    name: key,
    includeDiff: z.boolean().default(false),
    steps: z.array(nodeSchema).min(1),
  })
  .superRefine((template, ctx) => {
    for (const issue of stepGraphIssues(template.steps)) ctx.addIssue({ code: 'custom', ...issue });
  });
export type WorkflowNode = z.infer<typeof nodeSchema>;
export type WorkflowTemplate = z.infer<typeof workflowTemplateSchema>;

export const diffReview = workflowTemplateSchema.parse({
  id: 'diff-review',
  includeDiff: true,
  name: '只审查当前 diff',
  steps: [
    {
      id: 'review',
      name: '审查当前改动',
      kind: 'review',
      backend: 'sihq-codex-readonly',
      instructions:
        '在当前 Git 工作树独立检查已暂存和未暂存的改动，报告具体问题、位置和验证证据。无法取得 diff 时返回 blocked。',
    },
  ],
});
