import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { decisionSchema } from './agent.js';
import { readModelArtifact, type ModelKind, type ModelResult } from './artifacts.js';
import { reached, transient } from './budget.js';
import { capabilities } from './diagnostics.js';
import { validateFamilyAction } from './families.js';
import { questions, validateResearchDecision } from './research.js';
import { atomic, manifest, readJson } from './store.js';

import { PauseRequested, assertCandidate, same } from './runtime-types.js';
import type { KernelRuntime } from './runtime.js';
export function createModelExecutor(runtime: KernelRuntime) {
  const { s, store, root, deps, abort, experimentAbort, control, scoped, experimentDir, work } =
    runtime;
  const promptContext = () =>
    JSON.stringify({
      baseline: join(root, 'baseline'),
      parent: s.parent,
      artifacts: experimentDir(),
      readableIndex: join(root, 'INDEX.md'),
      familySummary: join(root, 'FAMILY.md'),
      objective: s.objective,
      experiment: s.experiment,
      profile: s.profile,
      sizes: s.sizes,
      budget: s.budget,
      researchMode: s.researchMode ?? 'legacy',
      researchPolicyStart: s.researchPolicyStart,
      questions: questions(root),
      questionsSummary: join(root, 'QUESTIONS.md'),
      capabilities,
      families: existsSync(join(root, 'families.json'))
        ? readJson(join(root, 'families.json'))
        : {},
      previous: s.results.slice(-8),
      allExperiments: join(root, 'state.json'),
      research: {
        guide: join(root, 'research/README.txt'),
        index: join(root, 'research/SOURCE_INDEX.txt'),
        catalog: join(root, 'research/SOURCES.json'),
        sourceRoot: s.references?.root,
        notes: join(root, 'research-notes.json'),
      },
      steering: existsSync(join(root, 'steering.jsonl'))
        ? readFileSync(join(root, 'steering.jsonl'), 'utf8')
        : '',
      reports: readdirSync(experimentDir())
        .filter((f) => f.endsWith('.json'))
        .map((f) => {
          const data = readJson(join(experimentDir(), f));
          if (f === 'diagnostics.json')
            return {
              file: join(experimentDir(), f),
              data: {
                status: data.status,
                error: data.error,
                reason: data.reason,
                requests: data.requests?.map((r: any) => ({
                  kind: r.kind,
                  targets: r.targets,
                  sizes: r.sizes,
                  reused: r.reused,
                  origin: r.origin,
                  results: r.results?.map((v: any) => ({
                    target: v.target,
                    nb: v.nb,
                    repeat: v.repeat,
                    log: v.log,
                    csv: v.csv,
                    logs: v.logs,
                  })),
                })),
              },
            };
          return { file: f, data };
        }),
    });
  async function model<K extends ModelKind>(kind: K, instruction: string): Promise<ModelResult<K>> {
    const dir = experimentDir(),
      file = join(dir, kind + '.json'),
      meta = join(dir, kind + '-source.json');
    const before = manifest(work());
    assertCandidate(work());
    if (existsSync(file) && existsSync(meta) && same(before, readJson(meta)))
      return readModelArtifact(file, kind);
    const attemptKey = `${s.experiment}:${kind}`,
      attemptLimit = s.budget.attempts === undefined ? 2 : s.budget.attempts;
    const retries = (s.networkFailures ??= {});
    if (!retries[attemptKey] && reached(s.attempts[attemptKey] ?? 0, attemptLimit))
      throw new Error(
        `阶段已达到${attemptLimit === 2 ? '两' : attemptLimit}次尝试上限，请检查记录并新建任务`,
      );
    if (!retries[attemptKey]) s.attempts[attemptKey] = (s.attempts[attemptKey] ?? 0) + 1;
    const stageStarted = Date.now();
    for (;;) {
      abort.signal.throwIfAborted();
      experimentAbort.signal.throwIfAborted();
      if (control().action === 'pause') throw new PauseRequested('已在重试边界暂停');
      if (reached(s.calls, s.budget.calls) || reached(s.tokens, s.budget.tokens))
        throw new Error('MODEL_BUDGET');
      if (
        s.budget.stageSeconds !== null &&
        Date.now() - stageStarted >= s.budget.stageSeconds * 1000
      )
        throw new Error('TimeoutError: 阶段总重试时间耗尽');
      s.calls++;
      store.save(s);
      store.event(s, 'agent.started', {
        kind,
        attempt: s.attempts[attemptKey],
        networkRetry: retries[attemptKey]?.count ?? 0,
      });
      let result;
      try {
        const recovery = retries[attemptKey]
          ? `\n上次调用因连接中断。继续已有会话，先检查已落盘修改，勿重复应用。调用前源码：${JSON.stringify(before)}；当前源码：${JSON.stringify(manifest(work()))}`
          : '';
        result = await scoped((signal) =>
          deps.agent(
            s,
            store,
            {
              kind,
              cwd: work(),
              prompt: instruction + recovery + '\n当前实验资料：' + promptContext(),
              output: join(dir, kind + '.events.jsonl'),
            },
            s.budget.stageSeconds === null
              ? signal
              : AbortSignal.any([
                  signal,
                  AbortSignal.timeout(
                    Math.max(1, s.budget.stageSeconds * 1000 - (Date.now() - stageStarted)),
                  ),
                ]),
          ),
        );
      } catch (error) {
        assertCandidate(work());
        if (!['develop', 'refactor'].includes(kind) && !same(before, manifest(work())))
          throw new Error('只读阶段修改了源码');
        if (!transient(error) || abort.signal.aborted || experimentAbort.signal.aborted) {
          delete retries[attemptKey];
          throw error;
        }
        const retry = (retries[attemptKey] ??= { count: 0, startedAt: Date.now(), lastError: '' });
        retry.count++;
        retry.lastError = String(error);
        const windowMs = (s.networkRetry?.windowSeconds ?? 600) * 1000;
        if (Date.now() - retry.startedAt >= windowMs) {
          store.save(s);
          throw new Error(
            '连接持续中断，重试窗口耗尽；现场已保存，修复网络后 resume：' + String(error),
          );
        }
        const ms =
          Math.min(
            (s.networkRetry?.maxDelaySeconds ?? 60) * 1000,
            1000 * 2 ** Math.min(retry.count - 1, 6),
          ) *
          (0.8 + Math.random() * 0.2);
        store.event(s, 'agent.retry', {
          kind,
          count: retry.count,
          delayMs: Math.round(ms),
          error: String(error),
        });
        store.save(s);
        const until = Date.now() + Math.min(ms, windowMs - (Date.now() - retry.startedAt));
        if (deps.retryDelay)
          await deps.retryDelay(ms, AbortSignal.any([abort.signal, experimentAbort.signal]));
        else
          while (Date.now() < until) {
            if (control().action === 'pause') throw new PauseRequested('已在网络重试等待中暂停');
            await delay(Math.min(250, until - Date.now()), undefined, {
              signal: AbortSignal.any([abort.signal, experimentAbort.signal]),
            });
          }
        continue;
      }
      assertCandidate(work());
      if (!['develop', 'refactor'].includes(kind) && !same(before, manifest(work())))
        throw new Error('只读阶段修改了源码');
      delete retries[attemptKey];
      atomic(file, result);
      atomic(meta, manifest(work()));
      store.event(s, 'agent.completed', { kind });
      return result as ModelResult<K>;
    }
  }
  async function decisionModel(
    kind: 'decide' | 'family_decide' | 'diagnostic_decide',
    instruction: string,
    verified?: boolean,
  ) {
    const planFile = join(experimentDir(), 'plan.json'),
      plan = existsSync(planFile) ? readJson(planFile) : undefined;
    let feedback = '';
    for (let correction = 0; ; correction++) {
      const result = decisionSchema.parse(await model(kind, instruction + feedback));
      try {
        validateResearchDecision(s, plan, result);
        validateFamilyAction(result, kind === 'family_decide', verified);
        return result;
      } catch (error) {
        atomic(join(experimentDir(), `${kind}-invalid-${correction}.json`), {
          result,
          error: String(error),
        });
        rmSync(join(experimentDir(), kind + '.json'), { force: true });
        rmSync(join(experimentDir(), kind + '-source.json'), { force: true });
        if (correction >= 2) throw error;
        feedback = '\n仅修正决策结构并给出研究问题结论，不重新实验。校验失败：' + String(error);
      }
    }
  }

  return { model, decisionModel };
}
