import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Keep the existing data root so upgrades share history and workspace locks.
export function dataDirectory(...parts: string[]): string {
  return join(homedir(), '.llm-coder', ...parts);
}
export function recordDirectory(root: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的记录 ID');
  return join(root, id);
}
export function atomicJson(path: string, value: unknown): void {
  atomicText(path, JSON.stringify(value, null, 2));
}
export function atomicText(path: string, content: string): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function readValidatedJson<T>(path: string, schema: { parse(value: unknown): T }): T {
  try {
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (cause) {
    throw new Error(`记录无效：${path}；${String(cause)}`, { cause });
  }
}
// Retains the PID-only on-disk protocol used by earlier versions.
export function lockFile(file: string): () => void {
  if (existsSync(file)) {
    const pid = Number(readFileSync(file, 'utf8'));
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('运行锁损坏，请检查记录目录');
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false;
    }
    if (alive) throw new Error('该任务正在运行，不能同时恢复');
    rmSync(file);
  }
  writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
  let released = false;
  return () => {
    if (!released) {
      rmSync(file, { force: true });
      released = true;
    }
  };
}
