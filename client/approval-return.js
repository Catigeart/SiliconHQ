import React from 'react';
import { button, h } from './ui.js';

export function ApprovalReturn({ targets, remaining, note, busy, submit }) {
  const [target, setTarget] = React.useState('');
  if (!targets?.length) return null;
  if (remaining <= 0) return h('p', null, '本轮修复次数已用尽。');
  return h(
    'div',
    null,
    h(
      'label',
      null,
      '退回目标步骤',
      h(
        'select',
        { value: target, onChange: (e) => setTarget(e.target.value) },
        h('option', { value: '' }, '选择要修改的步骤'),
        targets.map((item) => h('option', { key: item.id, value: item.id }, item.name)),
      ),
    ),
    h(
      'p',
      null,
      '请在决定说明中填写退回理由。从所选步骤到本次审批之间的步骤会重新执行，包括其中的开发步骤。本轮剩余修复次数为 ' +
        remaining +
        '。',
    ),
    button('退回修改', () => submit(target), busy || !target || !note.trim()),
  );
}
