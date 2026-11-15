import { z } from 'zod';
export const budgetSchema = z.object({
  attempts: z.number().int().min(1).nullable().default(2),
  experiments: z.number().int().min(1).max(100).nullable().default(2),
  seconds: z.number().int().min(10).max(604800).nullable().default(3600),
  calls: z.number().int().min(1).max(1000).nullable().default(16),
  stageSeconds: z.number().int().min(1).max(86400).nullable().default(600),
  tokens: z.number().int().min(1).max(100000000).nullable().default(1000000),
});
export type Budget = z.infer<typeof budgetSchema>;
