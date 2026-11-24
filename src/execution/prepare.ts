import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRoleConfig } from '../config/roles.js';
import { implementationSchema } from '../roles/developer.js';
import { getRoleDefinition, roles } from '../roles/index.js';
import { planSchema } from '../roles/planner.js';
import { reviewSnapshotSchema } from '../roles/reviewer.js';
import type { RoleContext, RoleName } from '../roles/types.js';
import { RunStore, type Run } from '../storage/runs.js';
import type { Workflow } from '../storage/workflows.js';
import { captureGit } from '../workspace/git.js';
import { prepareDeveloperFeedback, preparePlannerSummary } from './closeout.js';

export type TaskRequest =
  | { command: 'run' | 'plan'; prompt: string; cwd: string }
  | { command: 'implement'; sourceId: string }
  | { command: 'review'; sourceId: string }
  | { command: 'resume'; sourceId: string; prompt: string }
  | { command: 'developer-feedback'; workflow: Workflow }
  | { command: 'planner-summary'; workflow: Workflow };

function createRoleRun(
  store: RunStore,
  role: RoleName,
  prompt: string,
  cwd: string,
  links: Pick<Run, 'sourcePlanId' | 'sourceImplementationId'> = {},
  snapshot?: unknown,
  useCliConfig = true,
): Run {
  const config = useCliConfig ? loadRoleConfig(cwd, role) : {};
  const run = store.create(prompt, cwd);
  Object.assign(run, { role, ...config, ...links });
  try {
    const file = roles[role].snapshotFile;
    if (file)
      writeFileSync(join(store.directory(run.id), file), JSON.stringify(snapshot, null, 2), {
        mode: 0o600,
      });
    store.save(run);
  } catch (error) {
    run.status = 'failed';
    run.error = String(error);
    store.save(run);
    throw error;
  }
  return run;
}

export function prepareImplementation(store: RunStore, id: string, useCliConfig = true): Run {
  store.read(id);
  const unlock = store.lock(id);
  try {
    const source = store.read(id);
    if (source.role !== 'planner' || source.status !== 'completed')
      throw new Error('只能执行成功完成的 planner 计划');
    const plan = planSchema.parse(
      JSON.parse(readFileSync(join(store.directory(id), 'plan.json'), 'utf8')),
    );
    return createRoleRun(
      store,
      'developer',
      source.prompt,
      source.cwd,
      { sourcePlanId: id },
      {
        sourcePlanId: id,
        sourceUpdatedAt: source.updatedAt,
        originalRequirement: source.prompt,
        plan,
      },
      useCliConfig,
    );
  } finally {
    unlock();
  }
}

export function prepareReview(store: RunStore, id: string, useCliConfig = true): Run {
  store.read(id);
  const unlock = store.lock(id);
  try {
    const source = store.read(id);
    if (source.role !== 'developer' || source.status !== 'completed')
      throw new Error('只能检查已完成报告生成的 developer 任务');
    const dir = store.directory(id);
    const planSnapshot = JSON.parse(readFileSync(join(dir, 'plan-snapshot.json'), 'utf8'));
    const implementation = implementationSchema.parse(
      JSON.parse(readFileSync(join(dir, 'implementation.json'), 'utf8')),
    );
    const baselineFiles = readdirSync(dir)
      .filter((name) => /^git-before-\d+\.json$/.test(name))
      .sort();
    const snapshot = {
      sourceImplementationId: id,
      sourceUpdatedAt: source.updatedAt,
      planSnapshot,
      implementation,
      gitBaselines: baselineFiles.map((file) => ({
        file,
        data: JSON.parse(readFileSync(join(dir, file), 'utf8')),
      })),
    };
    reviewSnapshotSchema.parse(snapshot);
    return createRoleRun(
      store,
      'reviewer',
      source.prompt,
      source.cwd,
      {
        sourceImplementationId: id,
        sourcePlanId: source.sourcePlanId,
      },
      snapshot,
      useCliConfig,
    );
  } finally {
    unlock();
  }
}

export function prepareTask(
  store: RunStore,
  request: TaskRequest,
  useCliConfig = true,
): { run: Run; prompt: string } {
  if (request.command === 'developer-feedback')
    return {
      run: prepareDeveloperFeedback(store, request.workflow),
      prompt: '分析最后一次失败检查并向 planner 反馈，不再修改代码。',
    };
  if (request.command === 'planner-summary')
    return {
      run: preparePlannerSummary(store, request.workflow),
      prompt: '根据 developer 反馈和最后检查，向用户说明最终结果。',
    };
  if (request.command === 'implement')
    return {
      run: prepareImplementation(store, request.sourceId, useCliConfig),
      prompt: '按计划实现并验证。',
    };
  if (request.command === 'review')
    return {
      run: prepareReview(store, request.sourceId, useCliConfig),
      prompt: '独立检查实现并逐项验收。',
    };
  if (request.command === 'resume') {
    const run = store.read(request.sourceId);
    if (!run.threadId) throw new Error('该记录尚未建立 Codex 会话，不能恢复');
    return { run, prompt: request.prompt };
  }
  const run =
    request.command === 'plan'
      ? createRoleRun(store, 'planner', request.prompt, request.cwd, {}, undefined, useCliConfig)
      : store.create(request.prompt, request.cwd);
  return { run, prompt: request.prompt };
}

// 校验历史产物只读取快照，不重新采集 Git 或追加日志。
export function readRoleContext(store: RunStore, run: Run, instruction: string): RoleContext {
  const file = run.role ? getRoleDefinition(run.role, run.purpose).snapshotFile : undefined;
  return {
    instruction,
    snapshot: file
      ? JSON.parse(readFileSync(join(store.directory(run.id), file), 'utf8'))
      : undefined,
  };
}

export function prepareRoleContext(store: RunStore, run: Run, instruction: string): RoleContext {
  const context = readRoleContext(store, run, instruction);
  const prefix = run.role ? getRoleDefinition(run.role, run.purpose).gitBaseline : undefined;
  if (prefix) {
    context.git = captureGit(run.cwd);
    const file = `${prefix}-${Date.now()}.json`;
    writeFileSync(join(store.directory(run.id), file), JSON.stringify(context.git, null, 2), {
      mode: 0o600,
    });
    store.append(run.id, { type: prefix === 'git-before' ? 'git.baseline' : 'review.git', file });
  }
  return context;
}
