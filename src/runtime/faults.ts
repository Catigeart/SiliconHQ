export type FailureKind =
  | 'transport'
  | 'configuration'
  | 'output'
  | 'environment'
  | 'integrity'
  | 'unknown'
  | 'cancelled'
  | 'timeout'
  | 'resource';
export type RecoveryAction = 'retry' | 'correct' | 'reconcile' | 'stop';
export type Failure = {
  kind: FailureKind;
  code: string;
  message: string;
  action: RecoveryAction;
  status?: number;
  retryAfterMs?: number;
  provider?: string;
  threadId?: string;
  turnId?: string;
  details?: unknown;
};
export class ExecutionError extends Error {
  constructor(
    readonly failure: Failure,
    options?: ErrorOptions,
  ) {
    super(failure.message, options);
    this.name = 'ExecutionError';
  }
}
export function fault(
  kind: FailureKind,
  code: string,
  message: string,
  action: RecoveryAction = 'stop',
  details?: unknown,
): ExecutionError {
  return new ExecutionError({ kind, code, message, action, details });
}
export function outputError(error: unknown): ExecutionError {
  return fault('output', 'INVALID_OUTPUT', String(error), 'correct');
}
export function classify(error: unknown, seen = new Set<unknown>()): Failure {
  if (error instanceof ExecutionError) return error.failure;
  const e = error && typeof error === 'object' ? (error as Record<string, any>) : {};
  const message = e.message ?? String(error);
  const base = { message: String(message), code: String(e.code ?? 'UNKNOWN') };
  if (e.name === 'AbortError') return { ...base, kind: 'cancelled', action: 'stop' };
  if (e.name === 'TimeoutError') return { ...base, kind: 'timeout', action: 'reconcile' };
  const info = e.codexErrorInfo ?? e.error?.codexErrorInfo;
  const tag = typeof info === 'string' ? info : info && Object.keys(info)[0];
  const status =
    e.status ??
    e.statusCode ??
    (tag && typeof info === 'object' ? info[tag]?.httpStatusCode : undefined);
  const header = (name: string) => e.headers?.get?.(name) ?? e.headers?.[name];
  const retryMs = e.retryAfterMs ?? header('retry-after-ms');
  const retryAfter = e.retryAfter ?? header('retry-after');
  const parsedDelay =
    retryMs !== undefined
      ? Number(retryMs)
      : retryAfter !== undefined
        ? /^\d+(?:\.\d+)?$/.test(String(retryAfter))
          ? Number(retryAfter) * 1000
          : Date.parse(String(retryAfter)) - Date.now()
        : undefined;
  const retryAfterMs =
    parsedDelay !== undefined && Number.isFinite(parsedDelay)
      ? Math.max(0, parsedDelay)
      : undefined;
  const tagged = { ...base, code: tag ?? base.code, status, retryAfterMs, details: info };
  if (
    [
      'unauthorized',
      'badRequest',
      'modelNotFound',
      'usageLimitExceeded',
      'sessionBudgetExceeded',
      'contextWindowExceeded',
      'sandboxError',
      'inferenceHookDenied',
      'cyberPolicy',
      'misalignmentPolicyViolation',
      'tooManyDenials',
    ].includes(tag) ||
    (status !== undefined && status >= 400 && status < 500 && ![408, 429].includes(status))
  )
    return { ...tagged, kind: 'configuration', action: 'stop' };
  if (['ENOSPC', 'EACCES', 'ENOENT', 'EROFS'].includes(e.code))
    return { ...base, kind: 'environment', action: 'stop' };
  if (
    [
      'rateLimitExceeded',
      'serverOverloaded',
      'internalServerError',
      'flexUnavailable',
      'policyCapacityUnavailable',
    ].includes(tag) ||
    [408, 429, 500, 502, 503, 504, 529].includes(status) ||
    /^(ECONNRESET|ETIMEDOUT|EPIPE|ECONNREFUSED|EAI_AGAIN|UND_ERR_SOCKET|UND_ERR_CONNECT_TIMEOUT)$/.test(
      e.code ?? '',
    )
  )
    return { ...tagged, kind: 'transport', action: 'retry' };
  if (
    [
      'responseStreamDisconnected',
      'responseStreamConnectionFailed',
      'responseTooManyFailedAttempts',
      'httpConnectionFailed',
    ].includes(tag)
  )
    return { ...tagged, kind: 'transport', action: 'reconcile' };
  if (e.cause && !seen.has(e.cause)) {
    seen.add(error);
    const cause = classify(e.cause, seen);
    if (cause.kind !== 'unknown') return { ...cause, message: String(message) };
  }
  // Compatibility for exec/OS errors without structured metadata. Explicit permanent
  // errors take precedence over incidental numbers in URLs, messages, or source code.
  if (
    /invalid.*schema|invalid.*api.key|unauthorized|authentication failed|certificate.verify|permission denied/i.test(
      message,
    )
  )
    return { ...base, kind: 'configuration', action: 'stop' };
  if (
    /workspace routing discovery failed|ECONNRESET|ETIMEDOUT|temporarily unavailable|provider unavailable|network error|fetch failed|tls handshake.*(?:eof|timeout)|stream disconnected|connection (?:reset|closed|lost)|unexpected eof|\b(?:HTTP|status|error)\s*[:=]?\s*(?:408|429|500|502|503|504|529)\b/i.test(
      message,
    )
  )
    return { ...base, kind: 'transport', action: 'retry' };
  return { ...base, kind: 'unknown', action: 'stop' };
}
