import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export type ProcessIdentity = { pid: number; start?: string; boot?: string };

let ownWindowsStart: string | undefined;

function windowsIdentity(pid: number): ProcessIdentity {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('无效的进程 ID');
  if (pid === process.pid && ownWindowsStart) return { pid, start: ownWindowsStart };
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    // FILETIME is the OS creation timestamp in UTC, independent of the caller's locale.
    const start = execFileSync(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `[Diagnostics.Process]::GetProcessById(${pid}).StartTime.ToFileTimeUtc()`,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8', timeout: 4000 },
    ).trim();
    if (/^[1-9][0-9]+$/.test(start)) {
      if (pid === process.pid) ownWindowsStart = start;
      return { pid, start };
    }
  } catch {
    // Restricted processes and hosts without PowerShell can only be checked by PID.
  }
  return { pid };
}

export function processIdentity(pid = process.pid): ProcessIdentity {
  if (process.platform === 'win32') return windowsIdentity(pid);
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return {
      pid,
      start: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19],
      boot: readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(),
    };
  } catch (error) {
    if (process.platform === 'linux') throw error;
    return { pid };
  }
}
export function ownerAlive(owner: ProcessIdentity): boolean {
  try {
    process.kill(owner.pid, 0);
    if (process.platform === 'linux') {
      const stat = readFileSync(`/proc/${owner.pid}/stat`, 'utf8');
      if (['Z', 'X'].includes(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[0]!)) return false;
    }
    if (!owner.start) return true; // Legacy PID-only records: conservative ownership.
    const current = processIdentity(owner.pid);
    if (!current.start) return true; // A failed identity lookup cannot establish that a lock is stale.
    return current.start === owner.start && current.boot === owner.boot;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    return true;
  }
}
