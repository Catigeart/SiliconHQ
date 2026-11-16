import { readdirSync } from 'node:fs';
import { agent } from './agent.js';
import { diagnose } from './diagnostics.js';
import { sanitize } from './sanitizer.js';
import { manifest } from './store.js';
import { verify } from './verify.js';
import { ExecutionError } from '../runtime/faults.js';

export type Dependencies = {
  agent: typeof agent;
  verify: typeof verify;
  sanitize?: typeof sanitize;
  diagnose?: typeof diagnose;
  retryDelay?: (ms: number, signal: AbortSignal) => Promise<void>;
};
export const production: Dependencies = { agent, verify, sanitize, diagnose };
export function same(a: unknown, b: unknown) {
  return JSON.stringify(a) === JSON.stringify(b);
}
export function assertCandidate(path: string) {
  if (readdirSync(path).some((name) => !['src', 'include', 'README.txt'].includes(name)))
    throw new Error('候选修改了允许范围外的文件；仅允许 src/ 和 include/');
  manifest(path);
}

export class PauseRequested extends ExecutionError {
  constructor(message: string) {
    super({ kind: 'cancelled', code: 'PAUSE_REQUESTED', message, action: 'stop' });
  }
}
