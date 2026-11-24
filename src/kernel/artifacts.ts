import { z } from 'zod';
import { readValidatedJson } from '../storage/files.js';
import { changeSchema, closeoutSchema, decisionSchema, planSchema, reviewSchema } from './agent.js';
export const modelSchemas = {
  plan: planSchema,
  develop: changeSchema,
  refactor: changeSchema,
  review: reviewSchema,
  final_review: reviewSchema,
  decide: decisionSchema,
  family_decide: decisionSchema,
  diagnostic_decide: decisionSchema,
  closeout: closeoutSchema,
};
export type ModelKind = keyof typeof modelSchemas;
export type ModelResult<K extends ModelKind> = z.infer<(typeof modelSchemas)[K]>;
export function readModelArtifact<K extends ModelKind>(path: string, kind: K): ModelResult<K> {
  const result = readValidatedJson<unknown>(path, modelSchemas[kind]) as ModelResult<K>;
  if ('verdict' in result && result.verdict === 'passed' && result.findings.length) {
    throw new Error(`审阅通过结论与问题列表矛盾：${path}`);
  }
  return result;
}
export const evidenceSchema = z
  .object({
    passed: z.boolean(),
    source: z.record(z.string(), z.string()),
    architectures: z.array(z.number()),
    sizes: z.array(z.number()),
    profile: z.string(),
    performance: z.array(
      z
        .object({
          nb: z.number().optional(),
          n: z.number().optional(),
          nrhs: z.number().optional(),
          blocks: z.number().optional(),
          uplo: z.number(),
          diag: z.number(),
          samples: z.array(z.number()),
          medianUs: z.number(),
          timingMethod: z.string().optional(),
          clockControl: z.string().optional(),
          iterations: z.number().optional(),
        })
        .passthrough()
        .refine(
          (row) =>
            (row.n !== undefined &&
              row.nrhs !== undefined &&
              row.nb === undefined &&
              row.blocks === undefined) ||
            (row.nb !== undefined &&
              row.blocks !== undefined &&
              row.n === undefined &&
              row.nrhs === undefined),
          '性能证据必须明确使用 n/nrhs 或 nb/blocks，不能缺项或混用',
        ),
    ),
    log: z.string(),
    error: z.string().optional(),
    targetRuntimeVerified: z.literal(false),
  })
  .passthrough();
export const readEvidence = (path: string) => readValidatedJson(path, evidenceSchema);
