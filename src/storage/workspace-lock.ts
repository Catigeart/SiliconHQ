import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory, lockFile } from './files.js';
import { setTimeout as delay } from 'node:timers/promises';
import { classify, ExecutionError } from '../runtime/faults.js';

// 对同一个真实目录串行执行 sihq 管理的任务，符号链接路径也使用同一把锁。
export function lockWorkspace(cwd: string): () => void {
  const key = createHash('sha256').update(realpathSync(cwd)).digest('hex').slice(0, 36);
  const directory = dataDirectory('workspace-locks', key);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    return lockFile(join(directory, 'lock'));
  } catch (error) {
    throw new ExecutionError(
      { ...classify(error), message: `工作目录已有任务或锁不可用：${cwd}；${String(error)}` },
      { cause: error },
    );
  }
}
export async function waitForWorkspace(
  cwd: string,
  signal: AbortSignal,
  waiting?: () => void,
): Promise<() => void> {
  let reported = false;
  for (;;) {
    signal.throwIfAborted();
    try {
      return lockWorkspace(cwd);
    } catch (error) {
      if (classify(error).code !== 'LOCKED') throw error;
      if (!reported) {
        waiting?.();
        reported = true;
      }
      await delay(250, undefined, { signal });
    }
  }
}
