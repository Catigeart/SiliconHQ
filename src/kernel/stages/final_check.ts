import type { StageContext, StageResult } from '../stage-context.js';
export async function handleFinalCheck(context: StageContext): Promise<StageResult> {
  const { transition, check } = context;

  const result = await check('final-check', true);
  transition(result.passed ? 'final_review' : 'decide');
}
