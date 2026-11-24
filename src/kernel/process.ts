import { closeSync, existsSync, openSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { executionScope } from '../runtime/context.js';
import { fault } from '../runtime/faults.js';
import { managedSpawn } from '../runtime/process.js';

function journalDirectory(cwd: string): string | undefined {
  let directory = cwd;
  while (directory !== dirname(directory)) {
    if (existsSync(join(directory, 'runtime.sqlite'))) return directory;
    directory = dirname(directory);
  }
}
export async function command(
  argv: string[],
  cwd: string,
  log: string,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const fd = openSync(log, 'a', 0o600);
  let process;
  try {
    process = managedSpawn(argv, { cwd, stdio: ['ignore', fd, fd] }, journalDirectory(cwd));
  } finally {
    closeSync(fd);
  }
  const abort = () => {
    void process.close().catch(() => {});
  };
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) abort();
    const exit = await process.exited;
    signal.throwIfAborted();
    if (exit.code !== 0)
      throw fault(
        'unknown',
        'COMMAND_FAILED',
        `命令失败 (${exit.code ?? exit.signal})：${argv.join(' ')}；日志 ${log}\n${readFileSync(log, 'utf8').slice(-2000)}`,
        'stop',
        { argv, cwd, log, exit },
      );
    executionScope.getStore()?.progress();
  } finally {
    signal.removeEventListener('abort', abort);
    await process.close();
  }
}
