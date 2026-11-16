import { AsyncLocalStorage } from 'node:async_hooks';
import type { Journal, Operation } from './journal.js';

export type ExecutionScope = {
  journal: Journal;
  operation: Operation;
  signal: AbortSignal;
  recovery: boolean;
  feedback?: string;
  progress(): void;
  provider(update: NonNullable<Operation['provider']>): void;
  event(type: string, data?: unknown): void;
};
export const executionScope = new AsyncLocalStorage<ExecutionScope>();
