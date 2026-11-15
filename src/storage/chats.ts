import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadRoleConfig, type ReasoningEffort } from '../config/roles.js';
import type { Speed } from '../config/speed.js';
import {
  atomicJson,
  dataDirectory,
  lockFile,
  readValidatedJson,
  recordDirectory,
} from './files.js';
import { chatRecordSchema } from './schemas.js';

export type Chat = {
  speed?: Speed;
  id: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  model: string;
  reasoningEffort: ReasoningEffort;
  threadId?: string;
  workflowIds: string[];
  latestWorkflowId?: string;
  recentMessages: { role: 'user' | 'assistant'; text: string }[];
};
export class ChatStore {
  constructor(readonly root = dataDirectory('chats')) {}
  directory(id: string): string {
    return recordDirectory(this.root, id);
  }
  create(cwd: string): Chat {
    const config = loadRoleConfig(cwd, 'planner');
    const chat: Chat = {
      id: randomUUID(),
      cwd,
      ...config,
      createdAt: new Date().toISOString(),
      updatedAt: '',
      workflowIds: [],
      recentMessages: [],
    };
    this.save(chat);
    return chat;
  }
  save(chat: Chat): void {
    const dir = this.directory(chat.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chat.updatedAt = new Date().toISOString();
    const path = join(dir, 'chat.json');
    atomicJson(path, chat);
  }
  read(id: string): Chat {
    const chat = readValidatedJson(join(this.directory(id), 'chat.json'), chatRecordSchema) as Chat;
    if (
      chat.id !== id ||
      typeof chat.cwd !== 'string' ||
      typeof chat.model !== 'string' ||
      !Array.isArray(chat.workflowIds) ||
      !Array.isArray(chat.recentMessages)
    )
      throw new Error('对话记录损坏');
    return chat;
  }
  append(chat: Chat, event: unknown): void {
    appendFileSync(
      join(this.directory(chat.id), 'events.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), event }) + '\n',
      { mode: 0o600 },
    );
  }
  remember(chat: Chat, role: 'user' | 'assistant', text: string): void {
    chat.recentMessages.push({ role, text: text.slice(0, 6000) });
    chat.recentMessages = chat.recentMessages.slice(-12);
    this.save(chat);
  }
  lock(id: string): () => void {
    return lockFile(join(this.directory(id), 'lock'));
  }
  list(): Chat[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((id) => /^[a-f0-9-]{36}$/.test(id))
      .map((id) => this.read(id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}
