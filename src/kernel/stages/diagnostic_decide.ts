import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { reached } from '../budget.js';
import { writeExperimentReport, writeResearchIndex } from '../reports.js';
import { recordQuestionOutcome } from '../research.js';
import { readJson } from '../store.js';

import type { StageContext, StageResult } from '../stage-context.js';
export async function handleDiagnosticDecide(context: StageContext): Promise<StageResult> {
  const { s, store, root, experimentDir, decisionModel, transition } = context;

  const decision = await decisionModel(
    'diagnostic_decide',
    '解释 diagnostics.json 的实际证据。未执行或 unavailable 不能视为通过；没有代码变化不产生新候选。只允许 continue/pause/stop，disposition=archive，parent=current；不要请求 sanitizer，不得宣称算法族或全局已验证。明确下一步可执行任务。',
  );
  if (
    decision.action === 'finalize_family' ||
    decision.disposition !== 'archive' ||
    decision.parent !== 'current' ||
    decision.stopReason === 'goal_converged'
  ) {
    rmSync(join(experimentDir(), 'diagnostic_decide.json'), { force: true });
    throw new Error('诊断决策不得提升候选或结束算法族');
  }
  if (!s.results.some((r) => r.experiment === s.experiment))
    s.results.push({ experiment: s.experiment, eligible: false, path: experimentDir(), decision });
  recordQuestionOutcome(root, s, readJson(join(experimentDir(), 'plan.json')), decision);
  writeExperimentReport(root, s.experiment);
  writeResearchIndex(root, s);
  store.event(s, 'diagnostic.completed', { decision });
  if (reached(s.experiment, s.budget.experiments)) {
    s.status = 'budget_exhausted';
    return 'stop';
  }
  s.experiment++;
  transition('plan');
  if (decision.action === 'stop' || decision.action === 'pause') {
    s.status = decision.stopReason === 'environment_blocked' ? 'blocked' : 'paused';
    return 'stop';
  }
}
