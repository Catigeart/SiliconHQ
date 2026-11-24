import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readEvidence } from './artifacts.js';
import { atomic, copySource, manifest } from './store.js';
import { verify, type Evidence } from './verify.js';

import { createModelExecutor } from './model-executor.js';
import { same } from './runtime-types.js';
import type { KernelRuntime } from './runtime.js';
export function createStageContext(runtime: KernelRuntime) {
  const { s, root, store, deps, scoped, experimentDir, work } = runtime;
  async function check(name: string, performance: boolean): Promise<Evidence> {
    const dest = join(experimentDir(), name),
      file = join(dest, 'evidence.json');
    if (deps.verify !== verify && existsSync(file)) {
      const old = readEvidence(file);
      if (old.passed && same(old.source, manifest(work()))) {
        atomic(join(experimentDir(), name + '.json'), old);
        return old;
      }
    }
    const result = await scoped((signal) =>
      deps.verify(s, root, work(), dest, performance, signal),
    );
    atomic(join(experimentDir(), name + '.json'), result);
    store.event(s, 'verification.completed', result);
    return result;
  }
  function snapshot(name: string) {
    const dest = join(experimentDir(), name);
    if (existsSync(dest)) {
      if (!same(manifest(dest), manifest(work()))) throw new Error('归档快照与当前源码不一致');
    } else copySource(work(), dest);
    atomic(join(experimentDir(), name + '-manifest.json'), manifest(dest));
  }

  return { ...runtime, ...createModelExecutor(runtime), check, snapshot };
}
export type StageContext = ReturnType<typeof createStageContext>;
export type StageResult = 'stop' | 'continue' | void;
