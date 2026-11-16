import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export function captureGit(cwd: string): unknown {
  const inspect = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
  if (inspect.error) throw inspect.error;
  if (inspect.status !== 0) {
    if (inspect.stderr.includes('not a git repository'))
      return { available: false, reason: 'not a git repository' };
    throw new Error(`无法检查 Git：${inspect.stderr}`);
  }
  const read = (args: string[]) => {
    const result = spawnSync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 10000,
      maxBuffer: 20 * 1024 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout;
  };
  // Git 的未跟踪文件只有路径；额外记录内容哈希，供 reviewer 独立核对已有文件。
  const root = read(['rev-parse', '--show-toplevel']).trim();
  const paths = [
    ...new Set(
      read(['ls-files', '--full-name', '-z', '--cached', '--others', '--exclude-standard'])
        .split('\0')
        .filter(Boolean),
    ),
  ].sort();
  const files = paths.slice(0, 2000).map((path) => {
    try {
      const full = join(root, path);
      const stat = lstatSync(full);
      if (stat.isSymbolicLink()) return { path, symlink: readlinkSync(full) };
      if (!stat.isFile() || stat.size > 10 * 1024 * 1024)
        return { path, skipped: 'not a regular file or larger than 10 MiB' };
      return { path, sha256: createHash('sha256').update(readFileSync(full)).digest('hex') };
    } catch (error) {
      return { path, error: String(error) };
    }
  });
  const head = spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
    cwd,
    encoding: 'utf8',
    timeout: 10000,
  });
  return {
    available: true,
    root,
    head: head.status === 0 ? head.stdout.trim() : null,
    status: read(['status', '--porcelain=v1', '--untracked-files=all']),
    diff: read(['diff', '--no-ext-diff']),
    stagedDiff: read(['diff', '--cached', '--no-ext-diff']),
    files,
    filesTruncated: paths.length > files.length,
  };
}

// A non-Git workspace still needs a real fingerprint for crash recovery.
// Dependency/cache directories are outside this source snapshot contract.
export function captureWorkspace(cwd: string): unknown {
  const git = captureGit(cwd) as any;
  if (
    git.available &&
    !git.filesTruncated &&
    !git.files.some((file: any) => file.skipped || file.error)
  )
    return { head: git.head, status: git.status, files: git.files };
  const files: Record<string, string> = {};
  let bytes = 0;
  const walk = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (['.git', 'node_modules', '.llm-coder', '.cache', '__pycache__'].includes(name)) continue;
      const path = join(directory, name),
        stat = lstatSync(path),
        key = relative(cwd, path);
      if (stat.isSymbolicLink()) files[key] = 'symlink:' + readlinkSync(path);
      else if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) {
        bytes += stat.size;
        if (bytes > 256 * 1024 * 1024 || Object.keys(files).length >= 10000)
          throw new Error('工作目录超出完整源码指纹范围，请在更具体的项目目录执行');
        files[key] = createHash('sha256').update(readFileSync(path)).digest('hex');
      } else throw new Error('工作目录包含无法核对的特殊文件：' + key);
    }
  };
  walk(cwd);
  return { files };
}
