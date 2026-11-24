import React from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Checkbox, Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import { useLaunchContext } from './context-picker.js';
import { h } from './ui.js';
import { verificationSummary } from './verification.js';
import { CommandField } from './workflow-list.js';

const styles = `
  .sihq-launch-dialog[role="dialog"] { width: min(34rem, 100%); max-height: 100%; }
  .sihq-launch-dialog .sihq-launch-content { min-height: 0; overflow-y: auto; overscroll-behavior: contain; }
  .sihq-launch-form { display: grid; gap: 12px; overflow-wrap: anywhere; }
  .sihq-launch-form small, .sihq-launch-footer small { color: var(--dsw-alias-label-secondary); }
  .sihq-launch-form ul { margin-block: 4px; padding-inline-start: 20px; }
  .sihq-launch-field, .sihq-launch-footer { display: grid; gap: 6px; }
  .sihq-launch-field textarea {
    box-sizing: border-box; width: 100%; min-height: 5rem; resize: vertical; font: inherit;
    padding: 8px 12px; border: 1px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-sm);
    background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary);
  }
  .sihq-launch-field textarea:focus-visible {
    outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
    outline-offset: 1px;
  }
  .sihq-launch-form summary { cursor: pointer; }
  .sihq-launch-sources { display: grid; gap: 8px; padding-top: 8px; justify-items: start; }
  .sihq-launch-sources > div { min-width: 0; max-width: 100%; }
  .sihq-launch-footer { width: 100%; }
  .sihq-launch-actions { display: flex; justify-content: flex-end; flex-wrap: wrap; gap: 8px; }
`;

function Preflight({ report }) {
  if (!report) return null;
  return h(
    'section',
    { 'aria-label': '启动前检查' },
    h('strong', null, report.ok ? '启动前检查通过' : '启动前检查未通过'),
    report.diagnostics.length > 0 &&
      h(
        'ul',
        null,
        report.diagnostics.map((item, index) =>
          h('li', { key: index }, item.step + ' · ' + item.message),
        ),
      ),
  );
}

function LaunchDialog({ plan, loadSources, submit, continuation, close, documents }) {
  const { flow, cwd } = plan;
  const [inheritReports, setInheritReports] = React.useState(false);
  const [task, setTask] = React.useState('');
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState('');
  const [copyNotice, setCopyNotice] = React.useState('');
  const inFlight = React.useRef(false);
  const formId = React.useId();
  const statusId = React.useId();
  const context = useLaunchContext(loadSources, plan.diffRequired, submitting, documents);

  let blocked = context.blocked;
  if (!cwd) blocked = '请先为当前聊天关联本地项目。';
  else if (flow.preflight?.ok === false) blocked = '请先解决启动前检查中的问题。';
  else if (!blocked && !task.trim())
    blocked = continuation ? '请输入本轮追加需求。' : '请输入任务描述。';

  async function launch(event) {
    event.preventDefault();
    if (blocked || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError('');
    try {
      await submit(task.trim(), context.ids, inheritReports);
      close();
    } catch (failure) {
      inFlight.current = false;
      setSubmitting(false);
      setError(failure.message);
    }
  }

  const footer = h(
    'div',
    { className: 'sihq-launch-footer' },
    h('small', { id: statusId, role: 'status' }, submitting ? '正在提交…' : error || blocked),
    h(
      'div',
      { className: 'sihq-launch-actions' },
      h(Button, { variant: 'ghost', onClick: close }, submitting ? '关闭' : '取消'),
      h(
        Button,
        {
          variant: 'primary',
          type: 'submit',
          form: formId,
          'aria-describedby': statusId,
          disabled: submitting || Boolean(blocked),
        },
        continuation ? '开始下一轮' : '开始执行',
      ),
    ),
  );
  return h(
    Modal,
    {
      open: true,
      title: flow.name,
      closeLabel: '关闭启动确认',
      onClose: close,
      footer,
      className: 'sihq-launch-dialog',
      contentClassName: 'sihq-launch-content',
    },
    h('style', null, styles),
    h(
      'form',
      { id: formId, onSubmit: launch, className: 'sihq-launch-form' },
      h(
        'label',
        { className: 'sihq-launch-field' },
        continuation ? '本轮追加需求' : '任务',
        h('textarea', {
          'data-modal-autofocus': true,
          value: task,
          required: true,
          readOnly: submitting,
          rows: 3,
          placeholder: '例如：核对当前改动是否符合 README 中的要求',
          onChange: (event) => {
            setError('');
            setTask(event.currentTarget.value);
          },
        }),
      ),
      h('small', null, '工作目录 · ' + (cwd || '当前聊天尚未关联本地项目')),
      plan.command &&
        h(
          'details',
          null,
          h('summary', null, '查看调用指令'),
          h(CommandField, { command: plan.command, notify: setCopyNotice }),
          copyNotice && h('small', { role: 'status' }, copyNotice),
        ),
      continuation &&
        flow.canInheritReports &&
        h(Checkbox, {
          label: '各角色继承各自的上一轮报告',
          checked: inheritReports,
          disabled: submitting,
          onChange: setInheritReports,
        }),
      flow.summary && h('div', null, flow.summary),
      flow.rules && h('div', null, flow.rules),
      flow.verificationSteps?.length > 0 &&
        h(
          'section',
          null,
          h('strong', null, '将在此工作目录运行的验证命令'),
          h(
            'ul',
            null,
            flow.verificationSteps.map((step, index) =>
              h('li', { key: index }, verificationSummary(step)),
            ),
          ),
        ),
      h(Preflight, { report: flow.preflight }),
      flow.inheritsParentHistory &&
        h('small', null, '本流程的 fork Agent 还会继承父会话已完成轮次的历史。'),
      context.panel,
    ),
  );
}

// The command picker calls outside React. Modal portals into the document and
// the session scope owns the React root until dismissal or session teardown.
export function createTaskDialog() {
  let active;
  return (scope, plan, loadSources, submit, continuation, documents) => {
    if (active?.token === plan.token && active.scope === scope) return;
    active?.close();
    const close = () => {
      if (active?.close === close) void dispose();
    };
    const dispose = scope.effect(() => {
      const root = createRoot(document.createElement('div'));
      root.render(h(LaunchDialog, { plan, loadSources, submit, continuation, close, documents }));
      return () => {
        if (active?.close === close) active = undefined;
        root.unmount();
      };
    });
    active = { token: plan.token, scope, close };
  };
}
