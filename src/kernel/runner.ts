import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { lockWorkspace } from '../storage/workspace-lock.js';
import { readEvidence } from './artifacts.js';
import { reached } from './budget.js';
import { finishCloseout } from './closeout.js';
import {
  KernelStore,
  atomic,
  copySource,
  manifest,
  readJson,
  trustedManifest,
  readTrustedManifest,
} from './store.js';
import { type Evidence } from './verify.js';

import { PauseRequested, production, same, type Dependencies } from './runtime-types.js';
import { createKernelRuntime } from './runtime.js';
import { createStageContext } from './stage-context.js';
import { executeStage } from './stages/index.js';
import { classify } from '../runtime/faults.js';
import { recoverProcesses } from '../runtime/process.js';
export type { Dependencies } from './runtime-types.js';
export async function runKernel(
  id: string,
  store = new KernelStore(),
  deps: Dependencies = production,
): Promise<void> {
  const release = store.lock(id);
  try {
    const s = store.read(id);
    if (
      s.closeout?.status === 'completed' ||
      (['completed', 'budget_exhausted'].includes(s.status) && s.closeout?.status !== 'failed')
    )
      throw new Error('任务已结束或预算耗尽，不能自动续跑');
    const runtime = createKernelRuntime(s, store, deps);
    try {
      await recoverProcesses(store.dir(id));
      runtime.start();
      await driveKernel(runtime);
    } finally {
      runtime.dispose();
    }
  } finally {
    release();
  }
}
async function driveKernel(runtime: ReturnType<typeof createKernelRuntime>) {
  const {
    s,
    root,
    store,
    deps,
    abort,
    experimentAbort,
    control,
    interrupt,
    updateTime,
    scoped,
    transition,
    experimentDir,
    work,
  } = runtime;
  const context = createStageContext(runtime);
  try {
    if (s.closeout) {
      await finishCloseout(s, store, deps.agent, abort.signal);
      return;
    }
    while (true) {
      updateTime();
      abort.signal.throwIfAborted();
      if (control().action === 'stop') interrupt();
      experimentAbort.signal.throwIfAborted();
      if (reached(s.usedSeconds, s.budget.seconds)) {
        runtime.expire();
        throw new Error('总运行时间预算耗尽');
      }
      if (control().action === 'pause') {
        s.status = 'paused';
        break;
      }
      if (reached(s.calls, s.budget.calls) || reached(s.tokens, s.budget.tokens)) {
        s.status = 'budget_exhausted';
        break;
      }
      if (
        existsSync(join(root, 'trusted-manifest.json')) &&
        !same(trustedManifest(join(root, 'trusted')), readTrustedManifest(root))
      )
        throw new Error('固定测试源码被修改');
      if (
        existsSync(join(root, 'baseline-manifest.json')) &&
        !same(manifest(join(root, 'baseline')), readJson(join(root, 'baseline-manifest.json')))
      )
        throw new Error('基线源码被修改');
      store.event(s, 'stage.started');
      if (s.stage === 'baseline') {
        const dest = join(root, 'baseline-evidence');
        let result: Evidence;
        if (
          existsSync(join(dest, 'evidence.json')) &&
          readEvidence(join(dest, 'evidence.json')).passed &&
          same(readEvidence(join(dest, 'evidence.json')).source, manifest(join(root, 'baseline')))
        )
          result = readEvidence(join(dest, 'evidence.json'));
        else
          result = await scoped((signal) =>
            deps.verify(s, root, join(root, 'baseline'), dest, true, signal),
          );
        if (!result.passed) throw new Error('基线验证失败：' + result.error);
        transition('plan');
        continue;
      }
      mkdirSync(experimentDir(), { recursive: true });
      if (!existsSync(work())) copySource(s.parent, work());
      if (!existsSync(join(experimentDir(), 'parent.json')))
        atomic(join(experimentDir(), 'parent.json'), {
          path: s.parent,
          source: manifest(s.parent),
        });
      const unlock = lockWorkspace(work());
      try {
        if ((await executeStage(context)) === 'stop') break;
      } finally {
        unlock();
      }
    }
  } catch (error) {
    s.error = String(error);
    s.failure = classify(error);
    if ((runtime.deadline || runtime.requestedStop) && !s.closeout) {
      runtime.endExperiment();
      try {
        await finishCloseout(
          s,
          store,
          deps.agent,
          abort.signal,
          runtime.requestedStop ? 'user_stop' : 'time_limit',
        );
      } catch (closeoutError) {
        s.error = String(closeoutError);
        s.status = 'blocked';
        store.event(s, 'closeout.failed', { error: s.error });
      }
    } else if (error instanceof PauseRequested) {
      s.status = 'paused';
      delete s.error;
    } else {
      s.status = String(error).includes('MODEL_BUDGET') ? 'budget_exhausted' : 'blocked';
      store.event(s, 'interrupted', { error: s.error, status: s.status });
    }
  } finally {
    runtime.dispose();
    runtime.finish();
  }
}
