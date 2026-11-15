import { writeFileSync, renameSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { ThreadEvent } from '@openai/codex-sdk';
import { getRoleDefinition } from '../roles/index.js';
import type { RoleResult } from '../roles/types.js';
import { prepareRoleContext, readRoleContext } from './prepare.js';
import { runCodex } from '../adapters/codex.js';
import { RunStore, type Run } from '../storage/runs.js';

export type TaskObserver = {
  log(message: string): void;
  renderEvent(event: ThreadEvent): void;
};

// 与 CLI 无关：阶段失败记录在 Run 中，由调用者决定退出码或后续流程。
export async function executeTask(store: RunStore, run: Run, prompt: string, signal: AbortSignal, executionId: string = randomUUID(), observer?: TaskObserver): Promise<Run> {
  const unlock = store.lock(run.id);
  const log = observer?.log ?? console.error;
  try {
    run.executionId = executionId;
    signal.throwIfAborted();
    run.status = 'running';
    delete run.error;
    delete run.implementationOutcome;
    delete run.reviewVerdict;
    store.save(run);
    store.append(run.id, { type: 'request', prompt, cwd: run.cwd, executionId, model: run.model, speed: run.speed ?? 'inherit', reasoningEffort: run.reasoningEffort });
    log(`[运行] ${run.id}`);
    const role = run.role ? getRoleDefinition(run.role, run.purpose) : undefined;
    const context = prepareRoleContext(store, run, prompt);
    let answer = '';
    await runCodex(role ? role.buildPrompt(context) : prompt, signal, {
      cwd: run.cwd, threadId: run.threadId,
      model: run.model, speed: run.speed ?? 'inherit', reasoningEffort: run.reasoningEffort,
      sandboxMode: role?.sandboxMode, approvalPolicy: role ? 'never' : undefined,
      outputSchema: role?.outputSchema, displayMessages: role?.displayMessages, renderEvent: observer?.renderEvent,
      onEvent(event) {
        store.append(run.id, event);
        if (event.type === 'item.completed' && event.item.type === 'agent_message') answer = event.item.text;
        if (event.type === 'thread.started') { run.threadId = event.thread_id; store.save(run); }
      },
    });
    signal.throwIfAborted();
    if (role) {
      const result = role.parseResult(answer, context);
      const path = join(store.directory(run.id), role.artifactName);
      writeFileSync(path + '.tmp', JSON.stringify(result.artifact, null, 2), { mode: 0o600 });
      renameSync(path + '.tmp', path);
      run.implementationOutcome = result.outcome;
      run.reviewVerdict = result.verdict;
      log(`[${role.label}] ${result.verdict ? result.verdict + '：' : ''}${path}`);
    }
    run.status = 'completed';
  } catch (error) {
    run.status = signal.aborted ? 'cancelled' : 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    log(`llm-coder: ${run.status === 'cancelled' ? '已取消任务' : run.error}`);
  } finally {
    try { store.save(run); store.append(run.id, { type: 'run.finished', status: run.status, error: run.error }); }
    finally { unlock(); }
  }
  return run;
}

export function taskExitCode(run: Run): number {
  if (run.status === 'cancelled') return 130;
  return run.status !== 'completed' || run.implementationOutcome === 'incomplete' ||
    (run.reviewVerdict && run.reviewVerdict !== 'passed') ? 1 : 0;
}

export function readTaskResult(store: RunStore, run: Run): RoleResult | undefined {
  if (!run.role) return undefined;
  const role = getRoleDefinition(run.role, run.purpose);
  const answer = readFileSync(join(store.directory(run.id), role.artifactName), 'utf8');
  return role.parseResult(answer, readRoleContext(store, run, ''));
}

export function validateTaskResult(store: RunStore, run: Run): void {
  if (run.status !== 'completed') throw new Error('阶段尚未完成');
  const result = readTaskResult(store, run);
  if (result && (result.outcome !== run.implementationOutcome || result.verdict !== run.reviewVerdict)) {
    throw new Error('报告与运行状态不一致');
  }
}
