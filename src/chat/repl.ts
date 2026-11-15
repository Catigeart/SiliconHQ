import type { Speed } from '../config/speed.js';
import { createInterface } from 'node:readline';
import { realpathSync } from 'node:fs';
import { ChatStore } from '../storage/chats.js';
import { ChatSession } from './session.js';

export async function startChat(id?: string, speed?: Speed): Promise<void> {
  const store = new ChatStore();
  const chat = id ? store.read(id) : store.create(realpathSync(process.cwd()));
  realpathSync(chat.cwd);
  const release = store.lock(chat.id);
  if (speed) { chat.speed = speed; store.save(chat); }
  const terminal = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal, prompt: '你 > ' });
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let ended = false;
  let exiting = false;
  let active: AbortController | undefined;
  const print = (message: string) => process.stdout.write(message + '\n');
  const session = new ChatSession(chat, store, print);

  rl.on('line', line => {
    if (active && terminal) {
      print('助手 > 当前任务执行中，请等待或按 Ctrl+C 取消。');
      return;
    }
    lines.push(line); wake?.();
  });
  rl.on('close', () => { ended = true; wake?.(); });
  const interrupt = () => {
    if (active) active.abort();
    else { print('\n助手 > 输入 /exit 退出。'); rl.prompt(); }
  };
  const terminate = () => { exiting = true; active?.abort(); rl.close(); process.exitCode = 143; };
  rl.on('SIGINT', interrupt);
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);

  try {
    print(`llm-coder · ${chat.cwd}`);
    print(`对话 ${chat.id} · 输入 /help 查看命令，/exit 退出。`);
    print(`下次继续：llm-coder chat resume ${chat.id}`);
    while (!exiting) {
      if (!ended) rl.prompt();
      while (!lines.length && !ended) await new Promise<void>(resolve => { wake = resolve; });
      wake = undefined;
      const line = lines.shift();
      if (line === undefined) break;
      if (line.trim() === '/exit') break;
      active = new AbortController();
      try {
        await session.handle(line, active.signal);
      } catch (error) {
        print(active.signal.aborted ? '助手 > 已取消当前任务，可以继续输入。' : `助手 > ${error instanceof Error ? error.message : String(error)}`);
      } finally { active = undefined; }
    }
  } finally {
    rl.close();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    release();
  }
}
