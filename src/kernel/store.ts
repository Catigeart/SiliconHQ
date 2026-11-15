import { createHash, randomUUID } from 'node:crypto';
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
} from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { rolesConfigSchema } from '../config/roles.js';
import {
  atomicJson,
  dataDirectory,
  lockFile,
  readValidatedJson,
  recordDirectory,
} from '../storage/files.js';
import { parseKernelState } from './state-schema.js';

import { type Budget } from './budget-schema.js';
export { budgetSchema, type Budget } from './budget-schema.js';
export type Stage =
  | 'baseline'
  | 'plan'
  | 'diagnose'
  | 'diagnostic_decide'
  | 'develop'
  | 'check'
  | 'review'
  | 'refactor'
  | 'final_check'
  | 'final_review'
  | 'decide'
  | 'sanitizer'
  | 'family_decide'
  | 'family_finalize'
  | 'archive_family_decide'
  | 'closeout';
export type State = {
  schemaVersion?: 1;
  researchMode?: 'algorithm-exploration' | 'platform-tuning';
  researchPolicyStart?: number;
  networkRetry?: { windowSeconds: number; maxDelaySeconds: number };
  networkFailures?: Record<string, { count: number; startedAt: number; lastError: string }>;
  sanitizerPolicy?: 'family-final-v1';
  performancePolicy?: 'ncu-base-v1' | 'ncu-base-pitched-v2';
  timeOnly?: boolean;
  references?: { guide: string; root: string };
  testPolicy?: 'split-v1' | 'split-gpu-v2';
  closeout?: {
    status: 'pending' | 'running' | 'failed' | 'completed';
    stage: Stage;
    experiment: number;
    reason: 'time_limit' | 'user_stop';
    seconds: number;
    attempts: number;
    error?: string;
  };
  objective?: string;
  id: string;
  project: string;
  createdAt: string;
  updatedAt: string;
  status:
    | 'closing'
    | 'ready'
    | 'running'
    | 'paused'
    | 'stopped'
    | 'blocked'
    | 'budget_exhausted'
    | 'completed';
  stage: Stage;
  experiment: number;
  budget: Budget;
  usedSeconds: number;
  calls: number;
  tokens: number;
  profile: 'smoke' | 'full';
  sizes: number[];
  blocks: number[];
  iterations: number;
  roles: z.infer<typeof rolesConfigSchema>['roles'];
  workerPid?: number;
  heartbeat?: string;
  error?: string;
  parent: string;
  threads: Record<string, string>;
  attempts: Record<string, number>;
  results: {
    status?: 'completed' | 'cancelled';
    experiment: number;
    eligible: boolean;
    path: string;
    decision?: unknown;
  }[];
};
export const atomic = atomicJson;
export class KernelStore {
  constructor(readonly root = dataDirectory('kernel')) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  dir(id: string) {
    return recordDirectory(this.root, id);
  }
  read(id: string): State {
    const state = readValidatedJson(join(this.dir(id), 'state.json'), { parse: parseKernelState });
    if (state.id !== id) throw new Error('kernel 记录 ID 不匹配');
    return state;
  }
  save(s: State) {
    s.schemaVersion = 1;
    s.updatedAt = new Date().toISOString();
    atomic(join(this.dir(s.id), 'state.json'), s);
  }
  event(s: State, type: string, data: unknown = {}) {
    appendFileSync(
      join(this.dir(s.id), 'events.jsonl'),
      JSON.stringify({
        at: new Date().toISOString(),
        type,
        stage: s.stage,
        experiment: s.experiment,
        data,
      }) + '\n',
    );
  }
  lock(id: string) {
    return lockFile(join(this.dir(id), 'lock'));
  }
  list() {
    return readdirSync(this.root)
      .filter((id) => /^[a-f0-9-]{36}$/.test(id) && existsSync(join(this.dir(id), 'state.json')))
      .map((id) => this.read(id));
  }
}
// Source-only copies: reject symlinks and special files, never follow paths outside the candidate.
export function treeManifest(root: string, parts: string[] = []): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (lstatSync(dir).isSymbolicLink()) throw new Error('目录不允许符号链接：' + dir);
    for (const entry of readdirSync(dir).sort()) {
      const path = join(dir, entry),
        stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error('源码不允许符号链接：' + path);
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile())
        out[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
      else throw new Error('源码包含特殊文件：' + path);
    }
  };
  if (parts.length) for (const part of parts) walk(join(root, part));
  else walk(root);
  return out;
}
export function manifest(root: string) {
  return treeManifest(root, ['src', 'include']);
}
export function copySource(from: string, to: string) {
  manifest(from);
  const dest = to;
  to = dest + '.' + randomUUID() + '.tmp';
  mkdirSync(to, { recursive: true });
  for (const part of ['src', 'include'])
    cpSync(join(from, part), join(to, part), { recursive: true, errorOnExist: true, force: false });
  if (existsSync(join(from, 'README.txt')))
    cpSync(join(from, 'README.txt'), join(to, 'README.txt'));
  renameSync(to, dest);
}
export function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}
