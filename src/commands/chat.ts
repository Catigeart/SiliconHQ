import { startChat } from '../chat/repl.js';
import { ChatStore } from '../storage/chats.js';
import type { Command } from './parse.js';
export async function handleChat(command: Extract<Command, { kind: 'chat' }>): Promise<number> {
  if (command.action === 'list')
    for (const chat of new ChatStore().list())
      console.log(`${chat.id}\t${chat.cwd}\t${chat.updatedAt}`);
  else await startChat(command.action === 'resume' ? command.id : undefined, command.speed);
  return 0;
}
