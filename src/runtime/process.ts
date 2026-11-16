import { spawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicJson } from '../storage/atomic.js';
import { executionScope } from './context.js';
import { fault } from './faults.js';
import { ownerAlive, processIdentity, type ProcessIdentity } from './identity.js';

type OwnedProcess = {
  identity: ProcessIdentity;
  group: number;
  token: string;
  owner: ProcessIdentity;
};
function members(record: OwnedProcess): number[] {
  if (process.platform !== 'linux') return ownerAlive(record.identity) ? [record.identity.pid] : [];
  const found: number[] = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) !== record.group || ['Z', 'X'].includes(fields[0]!)) continue;
      const env = readFileSync(`/proc/${name}/environ`, 'utf8').split('\0');
      if (!env.includes(`SIHQ_PROCESS_TOKEN=${record.token}`))
        throw fault('integrity', 'PROCESS_OWNER_UNKNOWN', '进程组所有权无法确认，拒绝接管');
      found.push(Number(name));
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    }
  }
  return found;
}
function kill(record: OwnedProcess, signal: NodeJS.Signals) {
  if (!members(record).length) return;
  try {
    process.kill(process.platform === 'win32' ? record.group : -record.group, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
async function drain(record: OwnedProcess, graceMs: number) {
  kill(record, 'SIGTERM');
  const deadline = Date.now() + graceMs;
  while (members(record).length && Date.now() < deadline) await sleep(25);
  if (members(record).length) kill(record, 'SIGKILL');
  const hardDeadline = Date.now() + 2000;
  while (members(record).length && Date.now() < hardDeadline) await sleep(25);
  if (members(record).length)
    throw fault('integrity', 'PROCESS_NOT_STOPPED', '旧进程未退出，不能启动新执行者');
}
export async function recoverProcesses(directory: string): Promise<void> {
  const path = join(directory, 'processes');
  if (!existsSync(path)) return;
  for (const name of readdirSync(path).filter((n) => n.endsWith('.json'))) {
    const file = join(path, name);
    const record = JSON.parse(readFileSync(file, 'utf8')) as OwnedProcess;
    if (!record.token || !record.identity || !Number.isInteger(record.group) || record.group <= 0)
      throw fault('integrity', 'INVALID_PROCESS_RECORD', '进程记录损坏：' + file);
    if (ownerAlive(record.owner) && members(record).length)
      throw fault('resource', 'EXECUTOR_ALIVE', '原执行器仍在运行，不能接管');
    await drain(record, 2000);
    rmSync(file);
  }
}
export function managedSpawn(argv: string[], options: SpawnOptions, directory?: string) {
  directory ??= executionScope.getStore()?.journal.directory;
  const token = randomUUID();
  const child = spawn(argv[0]!, argv.slice(1), {
    ...options,
    detached: process.platform !== 'win32',
    env: { ...process.env, ...options.env, SIHQ_PROCESS_TOKEN: token },
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (code, signal) => resolve({ code, signal }));
    },
  );
  // Attach immediately so a spawn failure cannot become an unhandled rejection.
  void exited.catch(() => {});
  let record: OwnedProcess | undefined;
  let file: string | undefined;
  if (child.pid) {
    let identity: ProcessIdentity;
    try {
      identity = processIdentity(child.pid);
    } catch (error) {
      // A short command may exit before /proc is read. Its group and inherited
      // token still identify any surviving descendants for cleanup.
      if (!['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
        throw error;
      }
      identity = { pid: child.pid };
    }
    record = {
      identity,
      group: child.pid,
      token,
      owner: processIdentity(),
    };
    if (directory) {
      mkdirSync(join(directory, 'processes'), { recursive: true, mode: 0o700 });
      file = join(directory, 'processes', token + '.json');
      try {
        atomicJson(file, record);
      } catch (error) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
        throw error;
      }
    }
  }
  let closing: Promise<void> | undefined;
  const close = (graceMs = 2000) =>
    (closing ??= (async () => {
      try {
        if (record) await drain(record, graceMs);
        await exited.catch(() => {});
        if (file) rmSync(file, { force: true });
      } finally {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    })());
  return { child, exited, close };
}
