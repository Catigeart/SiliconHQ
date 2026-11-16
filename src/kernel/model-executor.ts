import { researchFor } from './research-config.js';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { decisionSchema } from './agent.js';
import { readModelArtifact, type ModelKind, type ModelResult } from './artifacts.js';
import { reached } from './budget.js';
import { executeOperation, fingerprint } from '../runtime/executor.js';
import { executionScope } from '../runtime/context.js';
import { diagnosticCapabilities } from './diagnostics.js';
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
      baselineEvidence: join(root, 'baseline-evidence/evidence.json'),
      parent: s.parent,
      artifacts: experimentDir(),
      readableIndex: join(root, 'INDEX.md'),
      familySummary: join(root, 'FAMILY.md'),
      researchConfig: researchFor(s),
      objective: s.objective,
      experiment: s.experiment,
      profile: s.profile,
      sizes: s.sizes,
      budget: s.budget,
      researchMode: s.researchMode ?? 'legacy',
      researchPolicyStart: s.researchPolicyStart,
      questions: questions(root),
      questionsSummary: join(root, 'QUESTIONS.md'),
      capabilities: diagnosticCapabilities(s, root),
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
                    n: v.n,
                    nrhs: v.nrhs,
                    repeat: v.repeat,
                    numericalPassed: v.numericalPassed,
                    failures: v.failures,
                    testScope: v.testScope,
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
    const identity = {
      kind,
      instruction,
      roles: s.roles,
      objective: s.objective,
      ...(s.researchConfig ? { researchConfig: s.researchConfig } : {}),
      contract: 2,
    };
    const inputDigest = fingerprint(identity);
    if (existsSync(file) && existsSync(meta)) {
      const saved = readJson(meta);
      if (
        same(before, saved.source ?? saved) &&
        (!saved.inputDigest || saved.inputDigest === inputDigest)
      )
        return readModelArtifact(file, kind);
    }
    const attemptKey = `${s.experiment}:${kind}`;
    const retries = (s.networkFailures ??= {});
    const journal = store.journal(s.id);
    const previous = journal.operation(`${attemptKey}:${inputDigest.slice(0, 16)}`);
    const continuing =
      previous &&
      (previous.phase !== 'blocked' ||
        ['retry', 'reconcile'].includes(previous.failure?.action ?? ''));
    const limit = s.budget.attempts === undefined ? 2 : s.budget.attempts;
    if (!continuing && !retries[attemptKey]) {
      if (reached(s.attempts[attemptKey] ?? 0, limit))
        throw new Error('阶段已达到尝试上限，请检查记录');
      s.attempts[attemptKey] = (s.attempts[attemptKey] ?? 0) + 1;
    }
    const result = await scoped((signal) =>
      executeOperation({
        journal,
        id: attemptKey,
        identity,
        signal,
        capture: () => {
          assertCandidate(work());
          return manifest(work());
        },
        readOnly: !['develop', 'refactor'].includes(kind),
        policy: s.networkRetry
          ? {
              windowMs: s.networkRetry.windowSeconds * 1000,
              maxDelayMs: s.networkRetry.maxDelaySeconds * 1000,
            }
          : undefined,
        delay: deps.retryDelay,
        checkControl() {
          if (control().action === 'pause') throw new PauseRequested('已在重试边界暂停');
        },
        beforeAttempt() {
          if (reached(s.calls, s.budget.calls) || reached(s.tokens, s.budget.tokens))
            throw new Error('MODEL_BUDGET');
          s.calls++;
          store.save(s);
          store.event(s, 'agent.started', { kind, attempt: s.attempts[attemptKey] });
        },
        onEvent(type, data: any) {
          if (data.operation) s.activeOperationId = data.operation;
          if (type === 'execution.retry') {
            retries[attemptKey] = {
              count: data.count,
              startedAt: data.startedAt,
              lastError: data.failure.message,
            };
            store.event(s, 'agent.retry', { kind, ...data, error: data.failure.message });
          }
          store.event(s, type, { kind, ...data });
          store.save(s);
        },
        invoke: (signal) =>
          deps.agent(
            s,
            store,
            {
              kind,
              cwd: work(),
              prompt:
                instruction +
                (executionScope.getStore()?.recovery
                  ? '\n上次调用中断。先核对已落盘修改，勿重复应用；继续完成剩余工作。'
                  : '') +
                '\n当前实验资料：' +
                promptContext(),
              output: join(dir, kind + '.events.jsonl'),
            },
            signal,
          ),
      }),
    );
    delete retries[attemptKey];
    atomic(file, result);
    atomic(meta, { source: manifest(work()), inputDigest });
    store.save(s);
    store.event(s, 'agent.completed', { kind });
    return result as ModelResult<K>;
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
