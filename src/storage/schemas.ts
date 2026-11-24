import { z } from 'zod';
import { reasoningEffortSchema } from '../config/roles.js';
import { speedSchema } from '../config/speed.js';
const record = z
  .object({
    id: z.string().regex(/^[a-f0-9-]{36}$/),
    cwd: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .passthrough();
const runStatus = z.enum(['running', 'completed', 'failed', 'cancelled', 'skipped']);
const stage = z.enum([
  'approval',
  'verify',
  'read',
  'plan',
  'implement',
  'review',
  'repair',
  'developer_feedback',
  'planner_summary',
]);
export const runRecordSchema = record.extend({
  prompt: z.string(),
  status: runStatus,
  role: z.enum(['planner', 'developer', 'reviewer']).optional(),
  purpose: z.enum(['developer_feedback', 'planner_summary']).optional(),
  threadId: z.string().optional(),
  executionId: z.string().optional(),
  model: z.string().optional(),
  speed: speedSchema.optional(),
  reasoningEffort: reasoningEffortSchema.optional(),
  reviewVerdict: z.enum(['passed', 'changes_requested', 'blocked']).optional(),
  implementationOutcome: z.enum(['implemented', 'incomplete']).optional(),
});
export const chatRecordSchema = record.extend({
  model: z.string(),
  reasoningEffort: reasoningEffortSchema,
  threadId: z.string().optional(),
  speed: speedSchema.optional(),
  workflowIds: z.array(z.string()),
  recentMessages: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string() })),
});
export const workflowRecordSchema = record.extend({
  prompt: z.string(),
  stage,
  status: z.enum([
    'running',
    'completed',
    'passed',
    'changes_requested',
    'incomplete',
    'blocked',
    'failed',
    'cancelled',
    'repair_limit_reached',
    'waiting_approval',
    'rejected',
  ]),
  steps: z.array(
    z
      .object({
        stage,
        runId: z.string(),
        status: runStatus,
        startedAt: z.string(),
        executionId: z.string().optional(),
      })
      .passthrough(),
  ),
  round: z.number().int().positive().optional(),
  archivedRounds: z.number().int().positive().optional(),
  rounds: z.array(z.record(z.string(), z.unknown())).optional(),
  maxRepairs: z.number().int().min(0).max(2).optional(),
  repairCount: z.number().int().nonnegative().optional(),
  speedOverride: speedSchema.optional(),
});
