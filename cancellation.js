import { addAbortListener } from 'node:events';

// Some host lookups do not take a signal. Stop waiting without letting a late
// result resume the caller, and observe any eventual rejection of the lookup.
export async function whileActive(work, signal) {
  if (!signal) return work;
  const interrupted = Promise.withResolvers();
  const listener = addAbortListener(signal, () => interrupted.reject(signal.reason));
  try {
    const value = await Promise.race([work, interrupted.promise]);
    signal.throwIfAborted();
    return value;
  } finally {
    listener[Symbol.dispose]();
  }
}

// DSH owns admission through its signal and transfers a published activation to the caller.
export async function withActivation(handle, signal, consume) {
  let disposal;
  const dispose = () => (disposal ??= Promise.resolve().then(() => handle.dispose()));
  const abort = () => {
    void dispose().catch(() => {});
  };
  const listener = addAbortListener(signal, abort);
  try {
    if (signal.aborted) abort();
    return await consume();
  } finally {
    listener[Symbol.dispose]();
    await dispose();
  }
}
