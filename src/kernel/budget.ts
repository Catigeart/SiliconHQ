import { budgetSchema, type Budget } from './store.js';
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
  if (error && typeof error === 'object') {
    const e = error as { status?: number; code?: string; cause?: unknown };
    if (e.status !== undefined) return [408, 429, 500, 502, 503, 504].includes(e.status);
    if (
      e.code &&
      /^(ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/.test(
        e.code,
      )
    )
      return true;
    if (e.cause && e.cause !== error && transient(e.cause)) return true;
  }
  return /\b(408|429|500|502|503|504)\b|ECONNRESET|ETIMEDOUT|temporarily unavailable|provider unavailable|network error|fetch failed|tls handshake.*(?:eof|timeout)|stream disconnected|connection (?:reset|closed)|unexpected eof/i.test(
    String(error),
  );
}
