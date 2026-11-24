import React from 'react';
import { button, h, panelStyle } from './ui.js';

export function Reassignment({ candidates, call, sessionId, id, busy, submit }) {
  const [open, setOpen] = React.useState(false);
  const [executionId, setExecutionId] = React.useState(candidates[0].executionId);
  const [instanceId, setInstanceId] = React.useState('');
  const [confirmed, setConfirmed] = React.useState(false);
  const [result, setResult] = React.useState(null);
  const [revision, reload] = React.useReducer((value) => value + 1, 0);

  React.useEffect(() => {
    if (!open) return;
    let active = true;
    call('reassignmentOptions', { sessionId, id, executionId })
      .then(({ options, excluded }) => {
        if (active) setResult({ executionId, options, excluded });
      })
      .catch((error) => {
        if (active) setResult({ executionId, error: error.message });
      });
    return () => {
      active = false;
    };
  }, [sessionId, id, executionId, open, revision, call]);

  const options = result?.executionId === executionId ? result.options : undefined;
  const error = result?.executionId === executionId ? result.error : undefined;
  const target = options?.find((item) => item.id === instanceId);
  function reloadOptions() {
    setResult(null);
    setInstanceId('');
    setConfirmed(false);
    reload();
  }

  if (!open) return button('改派失败步骤', () => setOpen(true), busy);
  return h(
    'fieldset',
    { disabled: busy, style: panelStyle },
    h('legend', null, '改派失败步骤'),
    h(
      'label',
      null,
      '失败步骤 ',
      h(
        'select',
        {
          'aria-label': '失败步骤',
          value: executionId,
          onChange: (event) => {
            setExecutionId(event.target.value);
            setInstanceId('');
            setConfirmed(false);
            setResult(null);
          },
        },
        candidates.map((step) =>
          h('option', { key: step.executionId, value: step.executionId }, step.name),
        ),
      ),
    ),
    error && h('p', { role: 'alert' }, error),
    !options && !error && h('small', { role: 'status' }, '正在读取兼容实例…'),
    options?.length > 0 &&
      h(
        'label',
        null,
        '新 Agent 实例 ',
        h(
          'select',
          {
            'aria-label': '新 Agent 实例',
            value: instanceId,
            onChange: (event) => {
              setInstanceId(event.target.value);
              setConfirmed(false);
            },
          },
          h('option', { value: '' }, '选择实例'),
          options.map((item) =>
            h(
              'option',
              { key: item.id, value: item.id },
              [item.name, item.model, item.reasoningEffort].filter(Boolean).join(' · '),
            ),
          ),
        ),
      ),
    options?.length === 0 &&
      h('p', null, '暂无兼容的命名实例。可在插件设置的「管理 Agent 实例」中添加，再刷新此列表。'),
    result?.executionId === executionId &&
      result.excluded?.length > 0 &&
      h(
        'details',
        null,
        h('summary', null, '查看不可选实例及原因'),
        h(
          'ul',
          null,
          result.excluded.map((row) => h('li', { key: row.id }, row.name + ' · ' + row.reason)),
        ),
      ),
    (error || options) && button('刷新实例列表', reloadOptions),
    h('small', null, '上次委派可能已经修改了文件。新实例将重新执行所选步骤。'),
    h(
      'label',
      null,
      h('input', {
        type: 'checkbox',
        'aria-label': '已核对工作区，允许重新委派',
        checked: confirmed,
        disabled: !target,
        onChange: (event) => setConfirmed(event.target.checked),
      }),
      ' 已核对工作区，允许重新委派',
    ),
    h(
      'div',
      null,
      button('确认改派', () => submit(executionId, target), !target || !confirmed),
      ' ',
      button('取消改派', () => {
        setOpen(false);
        setInstanceId('');
        setConfirmed(false);
        setResult(null);
      }),
    ),
  );
}
