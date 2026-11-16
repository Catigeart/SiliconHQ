import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { agent, closeoutSchema } from './agent.js';
import { executeOperation } from '../runtime/executor.js';
import { classify, outputError } from '../runtime/faults.js';
import { KernelStore, atomic, copySource, manifest, readJson, type State } from './store.js';

export async function finishCloseout(
  s: State,
  store: KernelStore,
  invoke: typeof agent,
  signal: AbortSignal,
  reason: 'time_limit' | 'user_stop' = 'time_limit',
): Promise<void> {
  const root = store.dir(s.id);
  s.closeout ??= {
    reason,
    status: 'pending',
    stage: s.stage,
    experiment: s.experiment,
    seconds: 0,
    attempts: 0,
  };
  const stoppedByUser = s.closeout.reason === 'user_stop';
  const prefix = stoppedByUser ? 'stop' : 'deadline';
  const explanation = stoppedByUser ? '用户请求停止' : '总实验时间到期';
  s.status = 'closing';
  s.stage = 'closeout';
  s.closeout.status = 'running';
  store.save(s);
  const cancelledDir = join(root, 'experiments', String(s.closeout.experiment));
  mkdirSync(cancelledDir, { recursive: true });
  if (!s.results.some((item) => item.experiment === s.closeout!.experiment)) {
    atomic(join(cancelledDir, 'cancelled.json'), {
      status: 'cancelled',
      reason: s.closeout.reason,
      stage: s.closeout.stage,
      verified: false,
    });
    s.results.push({
      status: 'cancelled',
      experiment: s.closeout.experiment,
      eligible: false,
      path: cancelledDir,
    });
    store.save(s);
  }
  const contextFile = join(root, prefix + '-context.json');
  if (!existsSync(contextFile)) {
    const dir = join(root, 'experiments', String(s.closeout.experiment)),
      candidate = join(dir, 'candidate');
    const source = existsSync(candidate) ? candidate : join(root, 'baseline');
    const snapshot = join(root, prefix + '-snapshot');
    let snapshotError: string | undefined;
    try {
      if (!existsSync(snapshot)) copySource(source, snapshot);
    } catch (error) {
      snapshotError = String(error);
    }
    atomic(contextFile, {
      reason: s.closeout.reason,
      experiment: s.closeout.experiment,
      interruptedStage: s.closeout.stage,
      cancelledRound: true,
      currentRoundVerified: false,
      source,
      snapshot: existsSync(snapshot) ? snapshot : null,
      snapshotError,
      manifest: !snapshotError ? manifest(snapshot) : null,
      results: s.results,
      researchNotes: join(root, 'research-notes.json'),
      reports: existsSync(dir)
        ? readdirSync(dir)
            .filter((f) => f.endsWith('.json'))
            .map((f) => ({ path: join(dir, f), data: readJson(join(dir, f)) }))
        : [],
      events: join(root, 'events.jsonl'),
      state: join(root, 'state.json'),
    });
    store.event(s, 'closeout.snapshot', { contextFile, snapshotError });
  }
  const output = join(root, 'summary.json');
  try {
    let summary;
    if (existsSync(output)) summary = closeoutSchema.parse(readJson(output));
    else {
      const context = readJson(contextFile);
      summary = closeoutSchema.parse(
        await executeOperation({
          journal: store.journal(s.id),
          id: `closeout:${s.closeout.reason}:${s.closeout.experiment}`,
          identity: { reason: s.closeout.reason, context, role: s.roles.planner, contract: 2 },
          signal,
          capture: () => manifest(join(root, 'baseline')),
          readOnly: true,
          policy: s.networkRetry
            ? {
                windowMs: s.networkRetry.windowSeconds * 1000,
                maxDelayMs: s.networkRetry.maxDelaySeconds * 1000,
              }
            : undefined,
          beforeAttempt() {
            s.closeout!.attempts++;
            s.calls++;
            store.save(s);
            store.event(s, 'closeout.started', { attempt: s.closeout!.attempts });
          },
          onEvent(type, data: any) {
            if (data.operation) s.activeOperationId = data.operation;
            store.event(s, type === 'execution.retry' ? 'closeout.retry' : type, data);
            store.save(s);
          },
          validate(value) {
            try {
              const result = closeoutSchema.parse(value);
              if (result.status !== s.closeout!.reason)
                throw new Error('总结停止原因与现场记录不一致');
              return result;
            } catch (error) {
              throw outputError(error);
            }
          },
          invoke: (signal) =>
            invoke(
              s,
              store,
              {
                kind: 'closeout',
                cwd: join(root, 'baseline'),
                prompt: `${explanation}，优化轮次已取消。报告 status 必须为 ${s.closeout!.reason}。只做现场记录与实验总结，不执行新实验。完整记录：${contextFile}。现场：${JSON.stringify({ ...context, results: context.results.slice(-8) })}`,
                output: join(root, 'closeout.events.jsonl'),
              },
              signal,
            ),
        }),
      );
      signal.throwIfAborted();
      if (summary.status !== s.closeout.reason) throw new Error('总结停止原因与现场记录不一致');
      atomic(output, summary);
    }
    if (summary.status !== s.closeout.reason) throw new Error('总结停止原因与现场记录不一致');
    writeFileSync(
      join(root, 'summary.txt'),
      [
        `${explanation}，实验已停止。`,
        summary.summary,
        ...[
          ['已完成', summary.completedWork],
          ['未完成', summary.unfinishedWork],
          ['保留发现', summary.retainedFindings],
          ['后续建议', summary.nextSteps],
          ['限制', summary.limitations],
        ].map(
          ([label, items]) =>
            `${label}\n${(items as string[]).map((item) => '- ' + item).join('\n')}`,
        ),
        `现场记录：${contextFile}`,
      ].join('\n\n') + '\n',
      { mode: 0o600 },
    );
    s.closeout.status = 'completed';
    delete s.closeout.error;
    delete s.error;
    delete s.failure;
    s.status = stoppedByUser ? 'stopped' : 'budget_exhausted';
    store.save(s);
    rmSync(join(root, 'summary-pending.json'), { force: true });
    rmSync(join(root, 'summary-pending.txt'), { force: true });
    store.event(s, 'closeout.completed', { summary: output });
  } catch (error) {
    s.closeout.status = 'failed';
    s.closeout.error = String(error);
    atomic(join(root, 'summary-pending.json'), {
      plannerSummaryPending: true,
      reason: s.closeout.reason,
      contextFile,
      experiment: s.closeout.experiment,
      interruptedStage: s.closeout.stage,
      completedExperiments: s.results.filter((item) => item.status !== 'cancelled').length,
      failure: classify(error),
      nextAction: `sihq kernel resume ${s.id}`,
    });
    writeFileSync(
      join(root, 'summary-pending.txt'),
      `${explanation}，当前轮次已取消，现场已保存。planner 总结尚未完成。\n现场：${contextFile}\n原因：${String(error)}\n恢复只会继续总结：sihq kernel resume ${s.id}\n`,
      { mode: 0o600 },
    );
    store.save(s);
    throw error;
  }
}
