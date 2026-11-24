import { researchFor } from './research-config.js';
import { appendFileSync } from 'node:fs';
import { z } from 'zod';
import { runCodex } from '../adapters/codex.js';
import { codexSchema, restoreOptionalFields } from './model-schema.js';
import { buildKernelPrompt } from './prompts.js';
import { changeKindSchema, outcomeSchema, portingGuideSchema, questionSchema } from './research.js';
import { KernelStore, type State } from './store.js';
import { executionScope } from '../runtime/context.js';

const text = z.string().min(1);
export const diagnosticSchema = z.strictObject({
  kind: z.enum(['codegen', 'kernels', 'paired', 'numerical']),
  targets: z
    .array(z.string().regex(/^(baseline|[1-9][0-9]*)$/))
    .min(1)
    .max(3),
  sizes: z
    .array(
      z
        .number()
        .int()
        .refine((n) => [32, 64, 128, 256, 512, 1024].includes(n)),
    )
    .min(1)
    .max(6),
  rhs: z
    .array(
      z
        .number()
        .int()
        .refine((n) => [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096].includes(n)),
    )
    .min(1)
    .max(13)
    .optional(),
  repeats: z.number().int().min(1).max(5),
  refresh: z.boolean().optional(),
  reason: text,
});
export const familyClosureSchema = z.strictObject({
  completedHypotheses: z.array(text).min(1),
  deferredHypotheses: z.array(text),
  reason: text,
  portingGuide: portingGuideSchema.optional(),
  representatives: z
    .array(z.strictObject({ experiment: z.number().int().positive(), reason: text }))
    .min(1)
    .max(6),
});
export const planSchema = z.strictObject({
  task: z.enum(['implement', 'diagnose', 'remeasure', 'finalize_family']),
  changeKind: changeKindSchema.optional(),
  researchQuestion: questionSchema.optional(),
  finalization: familyClosureSchema.optional(),
  familyId: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
  familyChangeReason: text.optional(),
  reopenReason: text.optional(),
  diagnostics: z.array(diagnosticSchema).max(3).optional(),
  localEvidence: z.array(z.strictObject({ path: text, explanation: text })).optional(),
  algorithmFamily: text,
  references: z
    .array(
      z.strictObject({
        path: text,
        symbol: text,
        sha256: z.string().regex(/^[a-f0-9]{64}$/),
        idea: text,
        limitations: text,
      }),
    )
    .describe(
      '仅包含 research.sourceRoot 内文件，禁止候选、基线或历史实验路径；本地证据放 localEvidence/hypothesis/changes。',
    ),
  borrowedIdeas: z.array(text),
  portabilityNotes: z.array(text),
  templateStrategy: text,
  parameterSpace: z.array(z.strictObject({ name: text, values: z.array(text), constraints: text })),
  hypothesis: text,
  changes: z.array(text).min(1),
  validation: z.array(text).min(1),
  expectedBenefit: text,
});
export const changeSchema = z.strictObject({
  summary: text,
  changes: z.array(text),
  parameters: z.array(text),
  remaining: z.array(text),
});
export const reviewSchema = z.strictObject({
  verdict: z.enum(['passed', 'changes_requested', 'blocked']),
  summary: text,
  findings: z.array(text),
  limitations: z.array(text),
});
export const closeoutSchema = z.strictObject({
  status: z.enum(['time_limit', 'user_stop']),
  summary: text,
  completedWork: z.array(text),
  unfinishedWork: z.array(text),
  retainedFindings: z.array(text),
  nextSteps: z.array(text),
  limitations: z.array(text),
});
export const decisionSchema = z.strictObject({
  familyAction: z.enum(['close', 'keep_open']).optional(),
  stopReason: z.enum([
    'branch_complete',
    'goal_converged',
    'environment_blocked',
    'user_requested',
  ]),
  action: z.enum(['continue', 'stop', 'pause', 'finalize_family']),
  disposition: z.enum(['retain', 'archive', 'reject']),
  reason: text,
  nextHypothesis: text,
  parent: z.enum(['baseline', 'current']),
  interpretation: text.optional(),
  uncertainties: z.array(text).optional(),
  questionOutcome: outcomeSchema.optional(),
  familyClosure: familyClosureSchema.optional(),
});
export type AgentInput = {
  kind:
    | 'plan'
    | 'develop'
    | 'review'
    | 'refactor'
    | 'final_review'
    | 'decide'
    | 'family_decide'
    | 'diagnostic_decide'
    | 'closeout';
  cwd: string;
  prompt: string;
  output: string;
};
export async function agent(
  s: State,
  store: KernelStore,
  input: AgentInput,
  signal: AbortSignal,
): Promise<unknown> {
  const role =
    input.kind === 'plan' ||
    input.kind === 'decide' ||
    input.kind === 'family_decide' ||
    input.kind === 'diagnostic_decide' ||
    input.kind === 'closeout'
      ? 'planner'
      : input.kind === 'review' || input.kind === 'final_review'
        ? 'reviewer'
        : 'developer';
  const key = input.kind === 'refactor' ? 'refactorer' : role;
  const config = s.roles[role];
  const schema =
    input.kind === 'closeout'
      ? closeoutSchema
      : input.kind === 'plan'
        ? planSchema
        : input.kind === 'decide' ||
            input.kind === 'family_decide' ||
            input.kind === 'diagnostic_decide'
          ? decisionSchema
          : role === 'reviewer'
            ? reviewSchema
            : changeSchema;
  const writable = input.kind === 'develop' || input.kind === 'refactor';
  const applicationSchema = z.toJSONSchema(schema);
  let answer = '';
  const parseAnswer = (answer: string) => {
    const result = schema.parse(restoreOptionalFields(JSON.parse(answer), applicationSchema));
    if ('verdict' in result && result.verdict === 'passed' && result.findings.length)
      throw new Error('审阅通过结论与问题列表矛盾');
    return result;
  };
  answer = await runCodex(buildKernelPrompt(input, researchFor(s)), signal, {
    cwd: input.cwd,
    ...config,
    threadId: s.threads[key],
    sandboxMode: writable ? 'workspace-write' : 'read-only',
    approvalPolicy: 'never',
    outputSchema: codexSchema(applicationSchema),
    validateOutput: parseAnswer,
    onRawEvent: (event) =>
      appendFileSync(
        input.output.replace('.events.jsonl', '.wire.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), event }) + '\n',
      ),
    renderEvent: () => {},
    onEvent: (event) => {
      appendFileSync(input.output, JSON.stringify({ at: new Date().toISOString(), event }) + '\n');
      if (event.type === 'item.started' && event.item.type === 'command_execution')
        store.event(s, 'agent.command', {
          kind: input.kind,
          command: event.item.command.slice(0, 1000),
        });
      if (event.type === 'item.completed' && event.item.type === 'file_change')
        store.event(s, 'agent.files', { kind: input.kind, changes: event.item.changes });
      if (event.type === 'thread.started') {
        s.threads[key] = event.thread_id;
        store.save(s);
      }
      if (event.type === 'item.completed' && event.item.type === 'agent_message')
        answer = event.item.text;
      if (event.type === 'turn.completed') {
        const scope = executionScope.getStore();
        const usageId =
          scope?.operation.provider?.turnId ?? `${scope?.operation.id}:${scope?.operation.attempt}`;
        s.accountedTurns ??= [];
        if (!s.accountedTurns.includes(usageId)) {
          s.tokens += event.usage.input_tokens + event.usage.output_tokens;
          s.accountedTurns.push(usageId);
        }
        store.save(s);
      }
    },
  });
  return parseAnswer(answer);
}
