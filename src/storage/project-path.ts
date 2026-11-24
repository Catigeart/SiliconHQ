import { realpathSync, statSync } from 'node:fs';
import { resolve } from 'node:path';

/** Resolve links and retrieve the actual on-disk spelling, including on Windows. */
export function canonicalProjectDirectory(cwd: string): string {
  const path = realpathSync.native(resolve(cwd));
  if (!statSync(path).isDirectory()) throw new Error('工作目录不是目录：' + cwd);
  return path;
}

/** Historical records may outlive their directory. Existing projects always use physical identity. */
export function projectDirectoryKey(cwd: string): string {
  try {
    return realpathSync.native(resolve(cwd));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    return resolve(cwd);
  }
}

export function sameProjectDirectory(a: string, b: string): boolean {
  return projectDirectoryKey(a) === projectDirectoryKey(b);
}
