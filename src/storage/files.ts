import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export { atomicJson, atomicText } from './atomic.js';
export { lockFile } from './lock.js';

// Keep the existing data root so upgrades share history and workspace locks.
export function dataDirectory(...parts: string[]): string {
  return join(homedir(), '.llm-coder', ...parts);
}
export function recordDirectory(root: string, id: string): string {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的记录 ID');
  return join(root, id);
}
export function readValidatedJson<T>(path: string, schema: { parse(value: unknown): T }): T {
  try {
    return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch (cause) {
    throw new Error(`记录无效：${path}；${String(cause)}`, { cause });
  }
}
