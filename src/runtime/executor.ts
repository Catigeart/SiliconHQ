import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { lockFile } from '../storage/lock.js';
import { executionScope } from './context.js';
import { classify, ExecutionError, fault, type Failure } from './faults.js';
import { Journal, type Operation } from './journal.js';
import { recoverProcesses } from './process.js';
import { recoveryPolicy } from './policy.js';

export const fingerprint = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export type ExecutionOptions<T> = {
  journal: Journal;
  id: string;
  identity: unknown;
  signal: AbortSignal;
  invoke(signal: AbortSignal): Promise<T>;
  capture?(): unknown;
  readOnly?: boolean;
  validate?(value: unknown): T;
  beforeAttempt?(operation: Operation): void;
  checkControl?(): void;
  onEvent?(type: string, data: unknown): void;
  policy?: { windowMs?: number; maxDelayMs?: number; idleMs?: number; corrections?: number };
  delay?(ms: number, signal: AbortSignal): Promise<void>;
};

// This is the only application-level retry owner. Provider reconnection notices
// stay inside one invocation. No second invocation starts before cleanup finishes.
export async function executeOperation<T>(options: ExecutionOptions<T>): Promise<T> {
  const { journal, signal } = options;
  const identity = fingerprint(options.identity);
  const id = `${options.id}:${identity.slice(0, 16)}`;
  const release = lockFile(
    join(journal.directory, `operation-${fingerprint(id).slice(0, 24)}.lock`),
  );
  const emit = (type: string, data: unknown = {}) => options.onEvent?.(type, data);
  let operation = journal.operation(id);
  try {
    await recoverProcesses(journal.directory);
    signal.throwIfAborted();
    options.checkControl?.();
    const current = options.capture?.();
    if (
      operation &&
      ['running', 'reconciling'].includes(operation.phase) &&
      options.readOnly &&
      options.capture &&
      fingerprint(operation.attemptBefore ?? operation.before) !== fingerprint(current)
    )
      throw fault(
        'integrity',
        'READ_ONLY_CRASH_CHANGED',
        '中断的只读调用期间源码发生变化，需先核对现场',
      );
    if (operation?.phase === 'completed') {
      if (options.capture && fingerprint(current) !== fingerprint(operation.after))
        throw fault(
          'integrity',
          'COMPLETED_SOURCE_CHANGED',
          '已完成调用的源码已变化，不能复用旧结果；请建立新操作',
        );
      const result = options.validate
        ? options.validate(operation.result)
        : (operation.result as T);
      emit('execution.reused', { operation: id });
      return result;
    }
    const recovery = !!operation;
    operation ??= {
      id,
      identity,
      phase: 'running',
      attempt: 0,
      corrections: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      lastProgressAt: Date.now(),
      before: current,
    };
    // An explicit new invocation after a blocked run grants a new recovery window;
    // retries inside this invocation never reset it. Crashed in-flight windows persist.
    if (['blocked', 'cancelled'].includes(operation.phase)) {
      delete operation.recoveryStartedAt;
      delete operation.nextRetryAt;
    }
    let feedback = operation.failure?.action === 'correct' ? operation.failure.message : undefined;
    const policy = { ...recoveryPolicy(), ...options.policy };
    const windowMs = policy.windowMs;
    const maxDelayMs = policy.maxDelayMs;
    const idleMs = policy.idleMs;
    let consecutiveFailures = 0;
    for (;;) {
      signal.throwIfAborted();
      options.checkControl?.();
      if (
        operation.recoveryStartedAt !== undefined &&
        Date.now() >= operation.recoveryStartedAt + windowMs
      )
        throw fault('timeout', 'RECOVERY_EXHAUSTED', '连接重试窗口耗尽；现场已保存，修复后 resume');
      if (operation.nextRetryAt && operation.nextRetryAt > Date.now()) {
        await waitUntil(operation.nextRetryAt);
      }
      options.beforeAttempt?.(operation);
      const attemptBefore = options.capture?.();
      operation.attemptBefore = attemptBefore;
      operation.attempt++;
      operation.phase = recovery || operation.attempt > 1 ? 'reconciling' : 'running';
      operation.lastProgressAt = Date.now();
      delete operation.nextRetryAt;
      journal.save(operation, 'execution.started');
      emit('execution.started', {
        operation: id,
        attempt: operation.attempt,
        phase: operation.phase,
      });
      const cancel = new AbortController();
      const combined = AbortSignal.any([signal, cancel.signal]);
      let lastPersist = Date.now();
      const monitor = setInterval(
        () => {
          if (
            operation!.recoveryStartedAt !== undefined &&
            Date.now() >= operation!.recoveryStartedAt + windowMs
          )
            cancel.abort(
              fault('timeout', 'RECOVERY_EXHAUSTED', '连接恢复截止时间已到，正在停止当前调用'),
            );
          else if (idleMs > 0 && Date.now() - operation!.lastProgressAt >= idleMs)
            cancel.abort(
              fault(
                'timeout',
                'NO_PROGRESS',
                '执行长时间没有可观察进展，核对现场后恢复',
                'reconcile',
              ),
            );
        },
        Math.min(250, Math.max(5, windowMs / 4), idleMs > 0 ? Math.max(5, idleMs / 4) : 250),
      );
      try {
        const result = await executionScope.run(
          {
            journal,
            operation,
            signal: combined,
            recovery: recovery || operation.attempt > 1,
            feedback,
            event: emit,
            progress() {
              operation!.lastProgressAt = Date.now();
              if (Date.now() - lastPersist >= 1000) {
                lastPersist = Date.now();
                journal.save(operation!);
              }
            },
            provider(update) {
              operation!.provider = { ...operation!.provider, ...update };
              journal.save(operation!);
            },
          },
          () => options.invoke(combined),
        );
        combined.throwIfAborted();
        const validated = options.validate ? options.validate(result) : result;
        operation.after = options.capture?.();
        if (
          options.readOnly &&
          options.capture &&
          fingerprint(attemptBefore) !== fingerprint(operation.after)
        )
          throw fault('integrity', 'READ_ONLY_CHANGED', '只读阶段修改了源码');
        operation.result = validated;
        operation.phase = 'completed';
        delete operation.failure;
        delete operation.nextRetryAt;
        delete operation.recoveryStartedAt;
        journal.save(operation, 'execution.completed');
        emit('execution.completed', { operation: id, attempt: operation.attempt });
        return validated;
      } catch (error) {
        // invoke must stop its processes before rejecting. Files may have changed
        // even though the provider supplied no final result.
        operation.after = options.capture?.();
        if (
          options.readOnly &&
          options.capture &&
          fingerprint(attemptBefore) !== fingerprint(operation.after)
        )
          throw fault('integrity', 'READ_ONLY_CHANGED', '只读阶段修改了源码');
        if (signal.aborted) throw signal.reason;
        const failure = classify(cancel.signal.aborted ? cancel.signal.reason : error);
        operation.failure = failure;
        if (failure.action === 'stop') throw new ExecutionError(failure, { cause: error });
        if (failure.action === 'correct') {
          if (operation.corrections >= policy.corrections)
            throw fault('output', 'CORRECTION_EXHAUSTED', '输出纠错次数耗尽：' + failure.message);
          operation.corrections++;
          feedback = failure.message;
          if (operation.provider) {
            delete operation.provider.turnId;
            delete operation.provider.terminal;
            operation.provider.submitted = false;
          }
          operation.phase = 'recovering';
          journal.save(operation, 'execution.correction');
          emit('execution.correction', { correction: operation.corrections, failure });
          continue;
        }
        operation.recoveryStartedAt ??= Date.now();
        consecutiveFailures++;
        const remaining = operation.recoveryStartedAt + windowMs - Date.now();
        if (remaining <= 0)
          throw fault(
            'timeout',
            'RECOVERY_EXHAUSTED',
            '连接重试窗口耗尽；现场已保存：' + failure.message,
          );
        const backoff = Math.min(maxDelayMs, 1000 * 2 ** Math.min(consecutiveFailures - 1, 10));
        const delayMs = Math.min(
          remaining,
          failure.retryAfterMs ?? backoff * (0.8 + Math.random() * 0.2),
        );
        operation.nextRetryAt = Date.now() + delayMs;
        operation.phase = 'recovering';
        journal.save(operation, 'execution.retry');
        emit('execution.retry', {
          operation: id,
          count: consecutiveFailures,
          delayMs,
          startedAt: operation.recoveryStartedAt,
          deadline: operation.recoveryStartedAt + windowMs,
          failure,
        });
      } finally {
        clearInterval(monitor);
      }
    }
  } catch (error) {
    if (operation && operation.phase !== 'completed') {
      operation.failure = signal.aborted
        ? { kind: 'cancelled', code: 'CANCELLED', message: String(signal.reason), action: 'stop' }
        : classify(error);
      operation.phase =
        signal.aborted || operation.failure.kind === 'cancelled' ? 'cancelled' : 'blocked';
      journal.save(operation, 'execution.interrupted');
      emit('execution.interrupted', { operation: id, failure: operation.failure });
    }
    throw error;
  } finally {
    release();
  }

  async function waitUntil(until: number) {
    if (options.delay) {
      await options.delay(Math.max(0, until - Date.now()), signal);
      return;
    }
    while (Date.now() < until) {
      options.checkControl?.();
      await sleep(Math.min(250, until - Date.now()), undefined, { signal });
    }
  }
}
