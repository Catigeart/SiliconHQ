import type { StageContext, StageResult } from '../stage-context.js';
export async function handleReview(context: StageContext): Promise<StageResult> {
  const { model, transition, check } = context;

  const result = await model(
    'review',
    '对实际代码独立审阅算法、架构限制、warp 同步、边界与 API；核对 first-check.json 的控制器测试证据。',
  );
  transition(result.verdict === 'passed' ? 'refactor' : 'decide');
}
