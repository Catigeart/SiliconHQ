import { baselineSource } from './workflow-git.js';
import { promptWithHandoff } from './workflow-handoff.js';
import { z } from 'zod';
import { planSchema } from './dist/roles/planner.js';
import { implementationSchema } from './dist/roles/developer.js';
import {
  reviewSchema,
  blockingReviewSchema,
  blockingInstructions,
  recheckInstructions,
} from './dist/roles/reviewer.js';
const schemas = {
  plan: planSchema,
  develop: implementationSchema,
  review: reviewSchema,
  read: z.strictObject({
    summary: z.string().trim().min(1),
    evidence: z.array(z.string().trim().min(1)).min(1),
  }),
};
export const stepReportSchema = (step) =>
  step.kind === 'review' && step.reviewPolicy === 'blocking'
    ? blockingReviewSchema
    : schemas[step.kind];
export function buildStepInput(step, task, sources, { feedback, diff, previousReview, returned }) {
  const criteria = [...new Set(sources.flatMap((s) => s.report.acceptanceCriteria ?? []))];
  if (!criteria.length) criteria.push(task);
  const prompt = [
    step.instructions,
    '本轮用户需求：' + task,
    '上游产物：' + JSON.stringify(sources),
  ];
  if (feedback)
    prompt.push(
      (feedback.outcome === 'failed' ? '验证失败报告：' : '独立审查退回意见：') +
        JSON.stringify(feedback),
    );
  if (step.kind === 'review')
    prompt.push(
      '请独立核查工作区现状，逐字返回每条验收标准。' +
        (step.reviewPolicy === 'blocking'
          ? blockingInstructions
          : '发现具体缺陷返回 changes_requested；证据不足返回 blocked。') +
        '验收标准：' +
        JSON.stringify(criteria),
    );
  if (diff) prompt.push('本步骤开始时的 Git diff：' + JSON.stringify(diff));
  let text = prompt.join('\n');
  if (previousReview) text += recheckInstructions(previousReview);
  if (returned)
    text +=
      '\n人工退回修改意见：' +
      returned.note +
      '\n本步骤上次的报告：' +
      JSON.stringify(returned.report);
  return { prompt: text, criteria };
}

export function previewStepInput({
  step,
  inputs,
  includeDiff,
  repair,
  scenario = '',
  references = false,
}) {
  if (!Object.hasOwn(schemas, step.kind)) throw new Error('未知步骤类型');
  const sources = inputs.map(({ id, name, kind }) => ({
    node: id,
    report:
      kind === 'plan'
        ? { acceptanceCriteria: ['〈' + name + ' 的验收标准〉'] }
        : '〈' + name + ' 的报告〉',
  }));
  const { prompt } = buildStepInput(step, '〈本次聊天填写的任务〉', sources, {
    feedback:
      repair === 'verify'
        ? { outcome: 'failed', exitCode: 1, stdout: '〈验证输出〉', stderr: '〈验证错误〉' }
        : repair
          ? '〈本次审查退回的报告〉'
          : undefined,
    diff: step.currentDiff
      ? { staged: '〈本步骤开始时已暂存的改动〉', unstaged: '〈本步骤开始时未暂存的改动〉' }
      : undefined,
    previousReview:
      scenario === 'recheck' && step.reviewPolicy === 'blocking'
        ? {
            verdict: 'blocked',
            summary: '〈上次审查摘要〉',
            findings: [],
            suggestions: [],
            checks: [],
            limitations: ['〈待补证据〉'],
            criteria: [
              {
                criterion: '〈上次未通过的验收标准〉',
                result: 'not_verified',
                evidence: '〈上次证据〉',
              },
            ],
          }
        : undefined,
    returned:
      scenario === 'human'
        ? { note: '〈人工填写的退回理由〉', report: '〈本步骤上次的报告〉' }
        : undefined,
  });
  const handoff = includeDiff
    ? [baselineSource({ staged: '〈已暂存的改动〉', unstaged: '〈未暂存的改动〉' })]
    : [];
  if (references)
    handoff.push({
      id: 'sample-reference',
      kind: 'document',
      label: '〈选中的参考资料〉',
      text: '〈所选聊天、报告或文档正文〉',
    });
  return {
    prompt: promptWithHandoff(prompt, handoff),
    schema: z.toJSONSchema(stepReportSchema(step)),
  };
}
