import { prepareWorkspaceStops, verificationStops } from './workspace-verification.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { atomicJson } from './atomic.js';
import { dataDirectory, lockFile } from './files.js';
import { hasLiveLock } from './lock.js';
import { canonicalProjectDirectory } from './project-path.js';
import { setTimeout as delay } from 'node:timers/promises';
import { classify, ExecutionError, fault } from '../runtime/faults.js';
import { processIdentity } from '../runtime/identity.js';

type Workspace = { path: string; git: boolean; cwd?: string; readerSlot?: number };
const readerKey = (path: string, slot: number) => keyFor(path + '\0reader:' + slot);

function workspaceFor(cwd: string): Workspace {
  const project = canonicalProjectDirectory(cwd);
  for (let path = project; ; path = dirname(path)) {
    // Git uses a .git directory for a checkout or a .git file for a linked worktree/submodule.
    if (existsSync(join(path, '.git'))) return { path, git: true, cwd: project };
    if (dirname(path) === path) return { path: project, git: false, cwd: project };
  }
}

function keyFor(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 36);
}

function contains(parent: string, child: string): boolean {
  const childPath = relative(parent, child);
  return !isAbsolute(childPath) && childPath !== '..' && !childPath.startsWith('..' + sep);
}

function overlap(a: Workspace, b: Workspace): boolean {
  // A new nested checkout can enclose an existing job's actual cwd. Other
  // nested worktrees stay independent. Older markers lack the execution cwd.
  if (a.git && b.git && a.path !== b.path)
    return (
      (contains(a.path, b.path) && (!a.cwd || contains(b.path, a.cwd))) ||
      (contains(b.path, a.path) && (!b.cwd || contains(a.path, b.cwd)))
    );
  return contains(a.path, b.path) || contains(b.path, a.path);
}

function readWorkspace(directory: string, key: string): Workspace | undefined {
  const marker = join(directory, 'worktree-key');
  // Older keys had either no marker or an empty marker. Their paths cannot be reconstructed.
  try {
    const saved = JSON.parse(readFileSync(marker, 'utf8')) as Workspace;
    if (
      typeof saved?.path === 'string' &&
      (saved.readerSlot === undefined
        ? keyFor(saved.path) === key
        : Number.isSafeInteger(saved.readerSlot) &&
          saved.readerSlot >= 0 &&
          readerKey(saved.path, saved.readerSlot) === key) &&
      typeof saved.git === 'boolean'
    )
      return saved;
  } catch (error) {
    if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw error;
  }
  return undefined;
}

function checkOverlappingOwners(
  root: string,
  key: string,
  requested: Workspace,
  read: boolean,
): void {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === key || !/^[a-f0-9]{36}$/.test(entry.name)) continue;
    const directory = join(root, entry.name);
    const file = join(directory, 'lock');
    if (!existsSync(file) && !existsSync(file + '.sqlite')) continue;
    const held = readWorkspace(directory, entry.name);
    // Checking process start times on Windows can launch PowerShell. A verified
    // directory marker excludes unrelated owners without any process lookup.
    if (held && (!overlap(held, requested) || (read && held.readerSlot !== undefined))) continue;
    if (!hasLiveLock(file)) continue;
    if (!held)
      throw fault(
        'resource',
        'LOCKED',
        '已有旧版任务正在运行或无法识别其目录，待其释放工作区锁后可继续',
      );
    throw fault('resource', 'LOCKED', '重叠的工作目录已有任务正在运行：' + held.path);
  }
}

export function workspaceVerificationStops(cwd: string, flowId: string) {
  return verificationStops(workspaceFor(cwd), flowId);
}

export function lockWorkspace(cwd: string, mode: 'read' | 'write' = 'write'): () => void {
  return lockTemplateWorkspace(cwd, mode).release;
}

export function lockTemplateWorkspace(
  cwd: string,
  mode: 'read' | 'write',
  recoveringFlow?: string,
) {
  const workspace = workspaceFor(cwd);
  let key = keyFor(workspace.path);
  const root = dataDirectory('workspace-locks');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  try {
    const identity = processIdentity();
    // Serialize overlap checks and owner publication across processes. The admission
    // transaction holds no task data and ends as soon as the exact-key lock is acquired.
    const admission = new DatabaseSync(join(root, 'admission.sqlite'));
    try {
      admission.exec('PRAGMA busy_timeout=5000');
      const importStops =
        mode === 'write'
          ? prepareWorkspaceStops(admission, workspaceFor, (candidate) =>
              overlap(workspace, candidate),
            )
          : undefined;
      admission.exec('BEGIN IMMEDIATE');
      const conflicts = !importStops
        ? []
        : importStops().filter((stop) =>
            overlap(workspace, { path: stop.path, git: !!stop.git, cwd: stop.cwd ?? undefined }),
          );
      const owns = (stop: (typeof conflicts)[number]) =>
        recoveringFlow === stop.flowId && (!stop.cwd || workspace.cwd === stop.cwd);
      const other = conflicts.find((stop) => !owns(stop));
      // An old profile may have several waiting jobs in one checkout. Each owner can
      // reconcile its own job under the lease, then must pass this gate before running.
      function assertReady() {
        if (other)
          throw fault(
            'resource',
            'LOCKED',
            '验证任务尚未确认停止：' + other.jobId + '。请在原会话恢复流程 ' + other.flowId + '。',
          );
      }
      if (other && !conflicts.some(owns)) {
        admission.exec('COMMIT');
        assertReady();
      }
      if (mode === 'read') {
        // Independent lease files also fence older exclusive writers, which treat these markers conservatively.
        let slot = 0;
        while (hasLiveLock(join(root, readerKey(workspace.path, slot), 'lock'))) slot++;
        workspace.readerSlot = slot;
        key = readerKey(workspace.path, slot);
      }
      checkOverlappingOwners(root, key, workspace, mode === 'read');
      const directory = join(root, key);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      const release = lockFile(join(directory, 'lock'), identity);
      try {
        atomicJson(join(directory, 'worktree-key'), workspace);
        admission.exec('COMMIT');
      } catch (error) {
        release();
        throw error;
      }
      return {
        release,
        assertReady,
        stopsFor: (flowId: string) => verificationStops(workspace, flowId),
      };
    } finally {
      admission.close();
    }
  } catch (error) {
    if ([5, 6].includes((error as { errcode?: number }).errcode ?? 0))
      throw fault('resource', 'LOCKED', '工作区锁正在更新，请稍后再试：' + cwd);
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
