import { createHash } from 'node:crypto';
import { mkdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { RunStore } from './runs.js';

// 对同一个真实目录串行执行 llm-coder 管理的任务，符号链接路径也使用同一把锁。
export function lockWorkspace(cwd: string): () => void {
  const key=createHash('sha256').update(realpathSync(cwd)).digest('hex').slice(0,36);
  const locks=new RunStore(join(homedir(),'.llm-coder','workspace-locks'));
  mkdirSync(locks.directory(key),{recursive:true,mode:0o700});
  try { return locks.lock(key); }
  catch(error) { throw new Error(`工作目录已有任务或锁不可用：${cwd}；${String(error)}`); }
}
