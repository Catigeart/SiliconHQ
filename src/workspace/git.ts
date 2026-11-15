import { readFileSync, lstatSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

export function captureGit(cwd: string): unknown {
  const inspect = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, encoding: 'utf8', timeout: 10000 });
  if (inspect.error) throw inspect.error;
  if (inspect.status !== 0) {
    if (inspect.stderr.includes('not a git repository')) return { available: false, reason: 'not a git repository' };
    throw new Error(`无法检查 Git：${inspect.stderr}`);
  }
  const read = (args: string[]) => {
    const result = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 10000, maxBuffer: 20 * 1024 * 1024 });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  // Git 的未跟踪文件只有路径；额外记录内容哈希，供 reviewer 独立核对已有文件。
  const root = read(['rev-parse', '--show-toplevel']).trim();
  const paths = [...new Set(read(['ls-files', '--full-name', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean))].sort();
  const files = paths.slice(0, 2000).map(path => {
    try {
      const full = join(root, path);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) return { path, symlink: readlinkSync(full) };
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024) return { path, skipped: 'not a regular file or larger than 10 MiB' };
      return { path, sha256: createHash('sha256').update(readFileSync(full)).digest('hex') };
    } catch (error) { return { path, error: String(error) }; }
  });
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], { cwd, encoding: 'utf8', timeout: 10000 });
  return { available: true, root, head: head.status === 0 ? head.stdout.trim() : null,
    status: read(['status', '--porcelain=v1', '--untracked-files=all']),
    diff: read(['diff', '--no-ext-diff']), stagedDiff: read(['diff', '--cached', '--no-ext-diff']),
    files, filesTruncated: paths.length > files.length };

}
