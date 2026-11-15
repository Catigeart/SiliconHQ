import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ReasoningEffort } from '../config/roles.js';
import type { Speed } from '../config/speed.js';
import type { RoleName, RunPurpose } from '../roles/types.js';
import {
  atomicJson,
  dataDirectory,
  lockFile,
  readValidatedJson,
  recordDirectory,
} from './files.js';
import { runRecordSchema } from './schemas.js';

export type Run = {
  speed?: Speed;
  id: string;
  prompt: string;
  cwd: string;
  createdAt: string;
  updatedAt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  executionId?: string;
  workflowId?: string;
  threadId?: string;
  error?: string;
  role?: RoleName;
  purpose?: RunPurpose;
  sourceRunId?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  sourcePlanId?: string;
  sourceImplementationId?: string;
  reviewVerdict?: 'passed' | 'changes_requested' | 'blocked';
  implementationOutcome?: 'implemented' | 'incomplete';
};
export class RunStore {
  constructor(readonly root = dataDirectory('runs')) {}
  directory(id: string): string {
    return recordDirectory(this.root, id);
  }
  save(run: Run): void {
    const dir = this.directory(run.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    run.updatedAt = new Date().toISOString();
    atomicJson(join(dir, 'run.json'), run);
  }
  create(prompt: string, cwd: string): Run {
    const run: Run = {
      id: randomUUID(),
      prompt,
      cwd,
      createdAt: new Date().toISOString(),
      updatedAt: '',
      status: 'running',
    };
    this.save(run);
    return run;
  }
  read(id: string): Run {
    const run = readValidatedJson(join(this.directory(id), 'run.json'), runRecordSchema) as Run;
    if (run.id !== id || typeof run.cwd !== 'string' || typeof run.prompt !== 'string')
      throw new Error('运行记录损坏');
    return run;
  }
  list(): Run[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root)
      .filter((id) => /^[a-f0-9-]{36}$/.test(id))
      .map((id) => this.read(id))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  append(id: string, event: unknown): void {
    appendFileSync(
      join(this.directory(id), 'events.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), event }) + '\n',
      { mode: 0o600 },
    );
  }
  lock(id: string): () => void {
    return lockFile(join(this.directory(id), 'lock'));
  }
}
