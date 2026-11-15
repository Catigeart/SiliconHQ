import type { StageContext, StageResult } from '../stage-context.js';
export async function handleCheck(context: StageContext): Promise<StageResult> {
  const { transition, check } = context;

  const result = await check('first-check', false);
  transition(result.passed ? 'review' : 'decide');
}
