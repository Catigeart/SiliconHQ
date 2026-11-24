import React from 'react';
import { button, h, panelStyle } from './ui.js';

// A broken row may lack a unique ID. Keep its editor bound to the same
// configuration revision and let the caller update exactly one array index.
export function RowRepair({
  title,
  noun,
  diagnostic,
  raw,
  revision,
  disabled,
  openEditor,
  deleteText,
  helperLabel,
  transform,
  save,
}) {
  const [draft, setDraft] = React.useState(null);
  const [error, setError] = React.useState('');
  const stale = draft && draft.revision !== revision;
  function start(mode) {
    setError('');
    setDraft({ mode, revision, text: JSON.stringify(raw, null, 2) });
  }
  async function submit() {
    if (!draft || stale || disabled) return;
    setError('');
    try {
      const value = draft.mode === 'delete' ? undefined : JSON.parse(draft.text);
      if (await save(value, draft.revision)) setDraft(null);
    } catch (e) {
      setError(e.message);
    }
  }
  function assist() {
    try {
      const next = transform(JSON.parse(draft.text));
      setDraft({ ...draft, text: JSON.stringify(next, null, 2) });
      setError('');
    } catch (e) {
      setError(e.message);
    }
  }
  return h(
    'article',
    { style: panelStyle, 'aria-label': title },
    h('strong', null, title + ' · 需要修复'),
    h('p', null, diagnostic),
    !draft &&
      h(
        'div',
        null,
        button('修复' + noun, openEditor ?? (() => start('repair')), disabled),
        ' ',
        button('删除' + noun, () => start('delete'), disabled),
      ),
    draft?.mode === 'repair' &&
      h(
        'div',
        null,
        h(
          'label',
          null,
          noun + '配置（JSON）',
          h('textarea', {
            value: draft.text,
            rows: 12,
            style: { width: '100%' },
            onChange: (e) => setDraft({ ...draft, text: e.target.value }),
          }),
        ),
        transform && button(helperLabel, assist, disabled || stale),
      ),
    draft?.mode === 'delete' && h('p', null, deleteText),
    stale && h('p', { role: 'alert' }, '配置已更新，请复制所需的草稿后取消并重新打开。'),
    draft &&
      h(
        'div',
        null,
        button(draft.mode === 'delete' ? '确认删除' : '保存修复', submit, disabled || stale),
        ' ',
        button('取消', () => setDraft(null)),
      ),
    error && h('p', { role: 'alert' }, error),
  );
}
