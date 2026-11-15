import type { Speed } from '../config/speed.js';
import { mkdirSync, writeFileSync, readFileSync, renameSync, appendFileSync, existsSync, readdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadRoleConfig, type ReasoningEffort } from '../config/roles.js';
import { RunStore } from './runs.js';

export type Chat = {
  speed?: Speed;
  id: string; cwd: string; createdAt: string; updatedAt: string;
  model: string; reasoningEffort: ReasoningEffort; threadId?: string;
  workflowIds: string[]; latestWorkflowId?: string;
  recentMessages: { role: 'user' | 'assistant'; text: string }[];
};
export class ChatStore {
  constructor(readonly root = join(homedir(), '.llm-coder', 'chats')) {}
  directory(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的 chat-id');
    return join(this.root, id);
  }
  create(cwd: string): Chat {
    const config = loadRoleConfig(cwd, 'planner');
    const chat: Chat = { id: randomUUID(), cwd, ...config, createdAt: new Date().toISOString(), updatedAt: '', workflowIds: [], recentMessages: [] };
    this.save(chat); return chat;
  }
  save(chat: Chat): void {
    const dir = this.directory(chat.id); mkdirSync(dir, { recursive: true, mode: 0o700 });
    chat.updatedAt = new Date().toISOString();
    const path = join(dir, 'chat.json');
    writeFileSync(path + '.tmp', JSON.stringify(chat, null, 2), { mode: 0o600 });
    renameSync(path + '.tmp', path);
  }
  read(id: string): Chat {
    const chat = JSON.parse(readFileSync(join(this.directory(id), 'chat.json'), 'utf8')) as Chat;
    if (chat.id !== id || typeof chat.cwd !== 'string' || typeof chat.model !== 'string' || !Array.isArray(chat.workflowIds) || !Array.isArray(chat.recentMessages)) throw new Error('对话记录损坏');
    return chat;
  }
  append(chat: Chat, event: unknown): void {
    appendFileSync(join(this.directory(chat.id), 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event }) + '\n', { mode: 0o600 });
  }
  remember(chat: Chat, role: 'user' | 'assistant', text: string): void {
    chat.recentMessages.push({ role, text: text.slice(0, 6000) });
    chat.recentMessages = chat.recentMessages.slice(-12);
    this.save(chat);
  }
  lock(id: string): () => void { return new RunStore(this.root).lock(id); }
  list(): Chat[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter(id => /^[a-f0-9-]{36}$/.test(id)).map(id => this.read(id)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
