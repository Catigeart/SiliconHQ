import { researchFor } from './research-config.js';
import { z } from 'zod';
import { rolesConfigSchema } from '../config/roles.js';
import { budgetSchema } from './budget-schema.js';
import type { State } from './store.js';

const count = z.number().int().nonnegative();
const stages = z.enum([
  'baseline',
  'plan',
  'diagnose',
  'diagnostic_decide',
  'develop',
  'check',
  'review',
  'refactor',
  'final_check',
  'final_review',
  'decide',
  'sanitizer',
  'family_decide',
  'family_finalize',
  'archive_family_decide',
  'closeout',
]);
const stateSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: z.string().regex(/^[a-f0-9-]{36}$/),
    project: z.string(),
    createdAt: z.string(),
    updatedAt: z.string(),
    status: z.enum([
      'closing',
      'ready',
      'running',
      'paused',
      'stopped',
      'blocked',
      'budget_exhausted',
      'completed',
    ]),
    stage: stages,
    experiment: z.number().int().positive(),
    budget: budgetSchema,
    usedSeconds: z.number().nonnegative(),
    calls: count,
    tokens: count,
    profile: z.enum(['smoke', 'full']),
    sizes: z.array(z.number().int().positive()),
    blocks: z.array(z.number().int().positive()),
    iterations: z.number().int().positive(),
    roles: rolesConfigSchema.shape.roles,
    parent: z.string(),
    threads: z.record(z.string(), z.string()),
    attempts: z.record(z.string(), count),
    results: z.array(
      z
        .object({
          status: z.enum(['completed', 'cancelled']).optional(),
          experiment: z.number().int().positive(),
          eligible: z.boolean(),
          path: z.string(),
          decision: z.unknown().optional(),
        })
        .passthrough(),
    ),
    researchMode: z.enum(['algorithm-exploration', 'platform-tuning']).optional(),
    researchPolicyStart: count.optional(),
    networkRetry: z
      .object({ windowSeconds: z.number().nonnegative(), maxDelaySeconds: z.number().positive() })
      .optional(),
    networkFailures: z
      .record(z.string(), z.object({ count, startedAt: z.number(), lastError: z.string() }))
      .optional(),
    sanitizerPolicy: z.literal('family-final-v1').optional(),
    performancePolicy: z.enum(['ncu-base-v1', 'ncu-base-pitched-v2']).optional(),
    timeOnly: z.boolean().optional(),
    references: z.object({ guide: z.string(), root: z.string() }).optional(),
    testPolicy: z.enum(['split-v1', 'split-gpu-v2']).optional(),
    closeout: z
      .object({
        status: z.enum(['pending', 'running', 'failed', 'completed']),
        stage: stages,
        experiment: count,
        reason: z.enum(['time_limit', 'user_stop']),
        seconds: z.number().nonnegative(),
        attempts: count,
        error: z.string().optional(),
      })
      .optional(),
    objective: z.string().optional(),
    workerPid: z.number().int().positive().optional(),
    heartbeat: z.string().optional(),
    error: z.string().optional(),
  })
  .passthrough();

// Version 0 is the pre-versioned format. Migration is in memory until the next save.
export function parseKernelState(value: unknown): State {
  const record = z.record(z.string(), z.unknown()).parse(value);
  const version = record.schemaVersion ?? 0;
  if (version !== 0 && version !== 1) throw new Error(`不支持的 kernel 状态版本：${version}`);
  const state = stateSchema.parse({ ...record, schemaVersion: 1 });
  researchFor(state as State);
  return state;
}
