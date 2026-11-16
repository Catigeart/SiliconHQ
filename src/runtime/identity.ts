import { readFileSync } from 'node:fs';

export type ProcessIdentity = { pid: number; start?: string; boot?: string };
export function processIdentity(pid = process.pid): ProcessIdentity {
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
    return current.start === owner.start && current.boot === owner.boot;
  } catch (error) {
    if (['ESRCH', 'ENOENT'].includes((error as NodeJS.ErrnoException).code ?? '')) return false;
    return true;
  }
}
