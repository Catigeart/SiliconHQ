import { Expandable, button, h, preStyle } from './ui.js';
import React from 'react';
import { agentName, isAgentStep } from '../dist/workflow/rules.js';
import { VerificationEvidence } from './verification.js';

const runStateNames = {
  running: '执行中',
  pending: '等待执行',
  completed: '已完成',
  passed: '审查通过',
  failed: '失败',
  blocked: '受阻',
  cancelled: '已取消',
  changes_requested: '需要修改',
  repair_limit_reached: '已用尽修复次数',
  incomplete: '开发未完成',
  waiting_approval: '等待人工确认',
  rejected: '已拒绝',
  skipped: '已跳过',
};

export const stateName = (status) => runStateNames[status] ?? status;

function DeliveryInput({ input }) {
  return h(
    Expandable,
    { summary: '查看实际委派输入' },
    input.sources?.length > 0 &&
      h('p', null, '引用内容 · ' + input.sources.map((s) => s.label || s.id).join('、')),
    h('pre', { style: preStyle, 'data-sihq-input': true }, input.prompt),
    input.structured &&
      input.outputSchema &&
      h(
        Expandable,
        { summary: '结构化输出要求' },
        h('pre', { style: preStyle }, JSON.stringify(input.outputSchema, null, 2)),
      ),
  );
}

function routeText(provider, model, effort) {
  return [[provider, model].filter(Boolean).join('/'), effort].filter(Boolean).join(' · ');
}

function ModelReceipt({ receipt, configured }) {
  const backend = configured?.baseBackend ?? configured?.backend;
  const resolved = receipt.resolvedRoute;
  const request = receipt.requestRoute;
  const modelProvider =
    configured?.backend === 'sihq-product-instance' ? undefined : configured?.provider;
  const planned = routeText(modelProvider, configured?.model, configured?.reasoningEffort);
  return h(
    'div',
    { 'aria-label': '执行模型信息' },
    h(
      'div',
      null,
      '指派 · ' +
        (configured
          ? [
              configured.instanceName,
              backend && agentName(backend),
              planned || '沿用默认',
              configured.agentPreset && '预设 ' + configured.agentPreset,
            ]
              .filter(Boolean)
              .join(' · ')
          : '没有保存指派配置'),
    ),
    resolved &&
      h(
        'div',
        null,
        'DSH 解析 · ' + routeText(resolved.provider, resolved.model, resolved.reasoningEffort),
      ),
    h(
      'div',
      null,
      receipt.observedModel
        ? '执行者回报的模型 · ' + receipt.observedModel
        : request?.model
          ? '实际请求 · ' + routeText(request.provider, request.model, request.reasoningEffort)
          : '实际模型 · 未报告',
    ),
  );
}

function PreviousAttempts({ attempts }) {
  return h(
    Expandable,
    { summary: '历史尝试' },
    attempts.map((attempt, index) => {
      return h(
        'article',
        { key: attempt.executionId },
        h('strong', null, '第 ' + (index + 1) + ' 次 · ' + stateName(attempt.status)),
        h('p', null, '尝试 ID · ' + attempt.executionId),
        attempt.childId && h('small', null, '子 Agent ID · ' + attempt.childId),
        h(ModelReceipt, { receipt: attempt, configured: attempt.route }),
        attempt.error && h('p', { style: preStyle }, attempt.error),
        attempt.input && h(DeliveryInput, { input: attempt.input }),
        attempt.answer &&
          h(
            Expandable,
            { summary: '查看当时的回复' },
            h(
              'pre',
              { style: preStyle },
              typeof attempt.answer === 'string'
                ? attempt.answer
                : JSON.stringify(attempt.answer, null, 2),
            ),
          ),
      );
    }),
  );
}

function ReviewIssues({ title, items }) {
  if (!items.length) return null;
  return h(
    'section',
    { 'aria-label': title },
    h('strong', null, title),
    h(
      'ul',
      null,
      items.map((f, i) =>
        h(
          'li',
          { key: i },
          h('strong', null, f.severity + ' · ' + f.problem),
          h('div', null, f.location + ' · ' + f.evidence),
          h('div', null, f.requestedChange),
        ),
      ),
    ),
  );
}

export function StepReport({ step }) {
  const [copyStatus, setCopyStatus] = React.useState('');
  const raw = step.report && JSON.stringify(step.report, null, 2);
  const commandReport = step.kind === 'verify' && Array.isArray(step.report?.argv);
  const rawView = raw && h('pre', { style: preStyle, 'data-sihq-report': true }, raw);
  async function copy() {
    try {
      await navigator.clipboard.writeText(raw);
      setCopyStatus('已复制完整报告。');
    } catch {
      setCopyStatus(
        commandReport ? '请展开完整报告 JSON，选中内容并复制。' : '请选中下方完整报告并复制。',
      );
    }
  }
  return h(
    React.Fragment,
    null,
    isAgentStep(step) &&
      step.status !== 'skipped' &&
      h(ModelReceipt, {
        receipt: step,
        configured: step.assignedRoute,
      }),
    step.childId && h('small', null, '子 Agent ID · ' + step.childId),
    (step.reportError || step.error) && h('p', { role: 'alert' }, step.reportError || step.error),
    raw &&
      h(
        React.Fragment,
        null,
        button('复制完整报告', copy),
        copyStatus && h('small', { role: 'status' }, copyStatus),
        Array.isArray(step.report.suggestions) &&
          h(
            React.Fragment,
            null,
            h(ReviewIssues, { title: '阻塞项', items: step.report.findings }),
            h(ReviewIssues, { title: '后续建议', items: step.report.suggestions }),
          ),
        commandReport && h(VerificationEvidence, { report: step.report }),
        commandReport || Array.isArray(step.report.suggestions)
          ? h(Expandable, { summary: '完整报告 JSON' }, rawView)
          : rawView,
      ),
    step.input && h(DeliveryInput, { input: step.input }),
    step.previousAttempts?.length > 0 && h(PreviousAttempts, { attempts: step.previousAttempts }),
    !step.input &&
      !step.waitingForCapacity &&
      isAgentStep(step) &&
      step.status !== 'skipped' &&
      h('small', null, '此步骤暂无已保存的委派输入。'),
  );
}
