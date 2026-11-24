import type { StageContext, StageResult } from '../stage-context.js';
export async function handleRefactor(context: StageContext): Promise<StageResult> {
  const { model, transition, snapshot } = context;

  await model(
    'refactor',
    '基于已验证实现，完成 plan 中分配给 refactorer 的工作，并处理 review 中的可读性/参数说明建议。合理提取模板参数；不要把基线已有的长期限制当作本轮算法改写任务，不改变验收标准。',
  );
  snapshot('refactored');
  transition('final_check');
}
