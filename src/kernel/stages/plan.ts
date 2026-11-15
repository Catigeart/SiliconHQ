import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { registerFamily, validateArchivedFinalization } from '../families.js';
import { recordReferences } from '../references.js';
import { registerQuestion, validateResearchPlan } from '../research.js';
import { atomic, manifest } from '../store.js';

import type { StageContext, StageResult } from '../stage-context.js';
export async function handlePlan(context: StageContext): Promise<StageResult> {
  const { s, store, root, experimentDir, model, transition } = context;

  let plan: Awaited<ReturnType<typeof model<'plan'>>> | undefined;
  let feedback = '';
  for (let correction = 0; correction < 3; correction++) {
    plan = await model(
      'plan',
      '根据历史结果选择可执行假设，明确 task、稳定 familyId 和模板复用策略。references 仅限 research.sourceRoot 内实际文件；候选或基线分析放 localEvidence/hypothesis/changes。诊断使用已公布 capabilities。' +
        feedback,
    );
    try {
      validateResearchPlan(root, s, plan);
      if (plan.task === 'finalize_family') {
        if (!s.sanitizerPolicy) throw new Error('算法族最终验证未启用 sanitizer');
        validateArchivedFinalization(root, s, plan);
      }
      if (['diagnose', 'remeasure'].includes(plan!.task) && !plan.diagnostics?.length)
        throw new Error('诊断任务必须提供 diagnostics');
      recordReferences(s, root, plan);
      registerFamily(root, s, plan);
      registerQuestion(root, s, plan);
      break;
    } catch (error) {
      atomic(join(experimentDir(), `plan-invalid-${correction}.json`), {
        plan,
        error: String(error),
      });
      rmSync(join(experimentDir(), 'plan.json'), { force: true });
      rmSync(join(experimentDir(), 'plan-source.json'), { force: true });
      if (correction === 2) throw error;
      feedback = '\n仅修正计划结构，不重新研究；控制器校验错误：' + String(error);
      store.event(s, 'plan.correction', { correction: correction + 1, error: String(error) });
    }
  }
  atomic(join(experimentDir(), 'parent.json'), { path: s.parent, source: manifest(s.parent) });
  transition(
    plan!.task === 'finalize_family'
      ? 'family_finalize'
      : ['diagnose', 'remeasure'].includes(plan!.task)
        ? 'diagnose'
        : 'develop',
  );
}
