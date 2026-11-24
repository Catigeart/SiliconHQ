import { startChat } from '../chat/repl.js';
import { ChatStore } from '../storage/chats.js';
import type { Command } from './parse.js';
import type { ProjectScope } from './project-scope.js';
export async function handleChat(
  command: Extract<Command, { kind: 'chat' }>,
  scope?: ProjectScope,
): Promise<number> {
  if (command.action === 'list') {
    for (const chat of new ChatStore().list()) {
      if (scope && !scope.includes(chat.cwd)) continue;
      console.log(`${chat.id}\t${chat.cwd}\t${chat.updatedAt}`);
    }
  } else {
    if (scope) throw new Error('交互式命令请在终端使用。');
    await startChat(command.action === 'resume' ? command.id : undefined, command.speed);
  }
  return 0;
}
