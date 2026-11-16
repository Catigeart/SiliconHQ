import { budgetSchema, type Budget } from './store.js';
import { classify } from '../runtime/faults.js';
export function reached(value: number, limit: number | null) {
  return limit !== null && value >= limit;
}
export function parseLimit(value: string): number | null {
  if (value === 'unlimited') return null;
  if (!/^\d+$/.test(value)) throw new Error('预算应为正整数或 unlimited');
  return Number(value);
}
export function resolveBudget(values: Record<string, number | null>, timeOnly: boolean): Budget {
  if (timeOnly)
    for (const key of ['experiments', 'calls', 'tokens', 'stageSeconds', 'attempts']) {
      if (values[key] !== undefined && values[key] !== null)
        throw new Error('--time-only 不接受其他有限预算：' + key);
    }
  return budgetSchema.parse({
    ...(timeOnly
      ? { experiments: null, calls: null, tokens: null, stageSeconds: null, attempts: null }
      : {}),
    ...values,
  });
}
export function transient(error: unknown): boolean {
  return ['retry', 'reconcile'].includes(classify(error).action);
}
