import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { reached } from './budget.js';
import { KernelStore, readJson, type Stage, type State } from './store.js';

import type { Dependencies } from './runtime-types.js';
import { processIdentity } from '../runtime/identity.js';
export function createKernelRuntime(s: State, store: KernelStore, deps: Dependencies) {
  const root = store.dir(s.id);
  const abort = new AbortController();
  const experimentAbort = new AbortController();
  let requestedStop = false;
  let deadline = false;
  const started = Date.now(),
    previousSeconds = s.usedSeconds,
    previousCloseoutSeconds = s.closeout?.seconds ?? 0;
  let experimentEndedAt: number | undefined = s.closeout ? started : undefined;
  const updateTime = () => {
    s.usedSeconds = previousSeconds + ((experimentEndedAt ?? Date.now()) - started) / 1000;
    if (s.closeout)
      s.closeout.seconds =
        previousCloseoutSeconds + (Date.now() - (experimentEndedAt ?? Date.now())) / 1000;
    s.heartbeat = new Date().toISOString();
  };
  const control = () =>
    existsSync(join(root, 'control.json'))
      ? readJson(join(root, 'control.json'))
      : { action: 'run' };
  const interrupt = () => {
    if (s.closeout) return;
    requestedStop = true;
    experimentAbort.abort(new Error('用户请求停止，准备总结'));
  };
  const transition = (stage: Stage) => {
    s.stage = stage;
    store.save(s);
  };
  const scoped = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const signals = [abort.signal, experimentAbort.signal];
    if (s.budget.stageSeconds !== null)
      signals.push(AbortSignal.timeout(s.budget.stageSeconds * 1000));
    const signal = AbortSignal.any(signals);
    const result = await fn(signal);
    signal.throwIfAborted();
    return result;
  };
  const experimentDir = () => join(root, 'experiments', String(s.experiment));
  const work = () => join(experimentDir(), 'candidate');

  let heartbeat: ReturnType<typeof setInterval> | undefined;
  function start() {
    process.on('SIGTERM', interrupt);
    process.on('SIGINT', interrupt);
    s.status = 'running';
    s.workerPid = process.pid;
    s.workerIdentity = processIdentity();
    delete s.error;
    delete s.failure;
    store.save(s);
    heartbeat = setInterval(() => {
      try {
        updateTime();
        if (!s.closeout && reached(s.usedSeconds, s.budget.seconds)) {
          deadline = true;
          experimentAbort.abort(new Error('总运行时间预算耗尽'));
        }
        if (control().action === 'stop') interrupt();
        store.save(s);
      } catch (error) {
        abort.abort(error);
      }
    }, 500);
  }
  function dispose() {
    if (heartbeat) clearInterval(heartbeat);
    process.off('SIGTERM', interrupt);
    process.off('SIGINT', interrupt);
  }
  function finish() {
    updateTime();
    delete s.workerPid;
    delete s.workerIdentity;
    store.save(s);
    store.event(s, 'worker.finished', { status: s.status });
  }
  return {
    s,
    root,
    store,
    deps,
    abort,
    experimentAbort,
    control,
    interrupt,
    updateTime,
    transition,
    scoped,
    experimentDir,
    work,
    start,
    dispose,
    finish,
    get requestedStop() {
      return requestedStop;
    },
    get deadline() {
      return deadline;
    },
    expire() {
      deadline = true;
    },
    endExperiment() {
      experimentEndedAt = Date.now();
    },
  };
}
export type KernelRuntime = ReturnType<typeof createKernelRuntime>;
