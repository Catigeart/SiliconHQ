function setting(name: string, fallback: number) {
  const value = process.env[name];
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)))
    throw new Error(`无效的执行策略：${name}`);
  return Number(value);
}
export function recoveryPolicy() {
  return {
    windowMs: setting('SIHQ_RECOVERY_WINDOW_MS', 600_000),
    maxDelayMs: setting('SIHQ_MAX_RETRY_DELAY_MS', 60_000),
    idleMs: setting('SIHQ_IDLE_TIMEOUT_MS', 600_000),
    corrections: setting('SIHQ_OUTPUT_CORRECTIONS', 2),
  };
}
