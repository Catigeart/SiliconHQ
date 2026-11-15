import type { Speed } from '../config/speed.js';
import { mkdirSync, writeFileSync, readFileSync, renameSync, appendFileSync, readdirSync, existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ReasoningEffort } from '../config/roles.js';
import type { RoleName, RunPurpose } from '../roles/types.js';

export type Run = {
  speed?: Speed;
  id: string; prompt: string; cwd: string; createdAt: string; updatedAt: string;
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  executionId?: string; workflowId?: string; threadId?: string; error?: string; role?: RoleName; purpose?: RunPurpose; sourceRunId?: string; model?: string; reasoningEffort?: ReasoningEffort; sourcePlanId?: string; sourceImplementationId?: string; reviewVerdict?: 'passed' | 'changes_requested' | 'blocked'; implementationOutcome?: 'implemented' | 'incomplete';
};
export class RunStore {
  constructor(readonly root = join(homedir(), '.llm-coder', 'runs')) {}
  directory(id: string): string {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('无效的 run-id');
    return join(this.root, id);
  }
  save(run: Run): void {
    const dir = this.directory(run.id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    run.updatedAt = new Date().toISOString();
    const tmp = join(dir, `run.${process.pid}.tmp`);
    writeFileSync(tmp, JSON.stringify(run, null, 2), { mode: 0o600 });
    renameSync(tmp, join(dir, 'run.json'));
  }
  create(prompt: string, cwd: string): Run {
    const run: Run = { id: randomUUID(), prompt, cwd, createdAt: new Date().toISOString(), updatedAt: '', status: 'running' };
    this.save(run);
    return run;
  }
  read(id: string): Run {
    const run = JSON.parse(readFileSync(join(this.directory(id), 'run.json'), 'utf8')) as Run;
    if (run.id !== id || typeof run.cwd !== 'string' || typeof run.prompt !== 'string') throw new Error('运行记录损坏');
    return run;
  }
  list(): Run[] {
    if (!existsSync(this.root)) return [];
    return readdirSync(this.root).filter(id => /^[a-f0-9-]{36}$/.test(id)).map(id => this.read(id)).sort((a,b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  append(id: string, event: unknown): void {
    appendFileSync(join(this.directory(id), 'events.jsonl'), JSON.stringify({ at: new Date().toISOString(), event }) + '\n', { mode: 0o600 });
  }
  lock(id: string): () => void {
    const file = join(this.directory(id), 'lock');
    if (existsSync(file)) {
      const pid = Number(readFileSync(file, 'utf8'));
      if (!Number.isInteger(pid) || pid <= 0) throw new Error('运行锁损坏，请检查记录目录');
      let alive = true;
      try { process.kill(pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
      if (alive) throw new Error('该任务正在运行，不能同时恢复');
      rmSync(file);
    }
    writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
    return () => rmSync(file, { force: true });
  }
}
