import { spawn } from 'node:child_process';
import { closeSync, openSync, readFileSync } from 'node:fs';

// Each trusted build/test owns a process group, so cancellation also kills descendants.
export function command(
  argv: string[],
  cwd: string,
  log: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const fd = openSync(log, 'a', 0o600);
    const child = spawn(argv[0]!, argv.slice(1), {
      cwd,
      stdio: ['ignore', fd, fd],
      detached: true,
    });
    closeSync(fd);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const kill = (sig: NodeJS.Signals) => {
      if (child.pid)
        try {
          process.kill(-child.pid, sig);
        } catch {}
    };
    const abort = () => {
      kill('SIGTERM');
      timer = setTimeout(() => kill('SIGKILL'), 2000);
    };
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', finish);
    child.once('close', (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(
              `命令失败 (${code})：${argv.join(' ')}；日志 ${log}\n${readFileSync(log, 'utf8').slice(-2000)}`,
            ),
      ),
    );
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (timer) {
        clearTimeout(timer);
        kill('SIGKILL');
      }
      if (signal.aborted) reject(signal.reason);
      else if (error) reject(error);
      else resolve();
    }
  });
}
