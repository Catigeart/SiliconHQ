import type { StageContext, StageResult } from '../stage-context.js';
export async function handleFinalReview(context: StageContext): Promise<StageResult> {
  const { model, transition, check } = context;

  await model(
    'final_review',
    '审查重构是否保持语义、可读性与模板参数约束；核对 final-check.json 的完整正确性与性能证据。性能变慢不等于正确性失败；只报告本机实测，目标平台尚未实测。',
  );
  transition('decide');
}
