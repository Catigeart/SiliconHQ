import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { dataDirectory, lockFile } from './files.js';

// 对同一个真实目录串行执行 sihq 管理的任务，符号链接路径也使用同一把锁。
export function lockWorkspace(cwd: string): () => void {
  const key = createHash('sha256').update(realpathSync(cwd)).digest('hex').slice(0, 36);
  const directory = dataDirectory('workspace-locks', key);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try {
    return lockFile(join(directory, 'lock'));
  } catch (error) {
    throw new Error(`工作目录已有任务或锁不可用：${cwd}；${String(error)}`);
  }
}
