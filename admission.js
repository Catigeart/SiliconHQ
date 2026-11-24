import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout';
import { whileActive } from './cancellation.js';
import { atomicJson } from './dist/storage/files.js';

async function waitForSlot(ctx, request, timeout) {
  const wake = Promise.withResolvers();
  const timer = setTimeout(wake.resolve, timeout);
  const abort = () => wake.resolve(undefined);
  let unsubscribe;
  try {
    request.signal.addEventListener('abort', abort, { once: true });
    request.signal.throwIfAborted();
    // RC5 emits this event after returning the slot. The timer also handles
    // capacity changes, startup rollbacks and slots freed elsewhere in the tree.
    unsubscribe = ctx?.on?.('subagent/end', (info) => {
      if (info?.parentSessionId === request.parent.id) wake.resolve(undefined);
    });
    await wake.promise;
    request.signal.throwIfAborted();
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener('abort', abort);
    unsubscribe?.();
  }
}

export async function startWithCapacity({
  ctx,
  service,
  request,
  prepare = (value) => value,
  receiptFile,
  onWaiting,
  timeoutMs = 15 * 60_000,
}) {
  let queueDeadline;
  let interval = 250;
  try {
    for (;;) {
      const signal = queueDeadline?.signal ?? request.signal;
      signal.throwIfAborted();
      const current = await whileActive(prepare({ ...request, signal }), signal);
      signal.throwIfAborted();
      atomicJson(receiptFile, { state: 'submitting' });
      try {
        // Once submitted, DSH owns admission; the queue timer must never cancel an accepted child.
        return await service.startActivation({ ...current, signal: request.signal });
      } catch (error) {
        if (error?.name !== 'SubagentError' || error.code !== 'ACTIVATION_LIMIT_REACHED')
          throw error;
      }
      atomicJson(receiptFile, { state: 'waiting_capacity' });
      if (!queueDeadline) {
        queueDeadline = deadline(request.signal, timeoutMs, 'SIHQ_CAPACITY_TIMEOUT');
        onWaiting?.();
      }
      await waitForSlot(ctx, { ...request, signal: queueDeadline.signal }, interval);
      interval = Math.min(5000, interval * 2);
    }
  } catch (error) {
    if (
      queueDeadline &&
      error === queueDeadline.signal.reason &&
      timeoutOf(queueDeadline.signal, 'SIHQ_CAPACITY_TIMEOUT')
    )
      throw new Error('等待 DSH 子 Agent 名额超时。步骤尚未派发，名额可用时可恢复运行。');
    throw error;
  } finally {
    queueDeadline?.[Symbol.dispose]();
  }
}
