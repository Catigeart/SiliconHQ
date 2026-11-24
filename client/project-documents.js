import React from 'react';
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives';
import { button, Expandable, h, preStyle } from './ui.js';

export function useProjectDocuments(load, submitting) {
  const [listing, setListing] = React.useState(null);
  const [matches, setMatches] = React.useState(null);
  const [truncated, setTruncated] = React.useState(false);
  const [term, setTerm] = React.useState('');
  const [hypo, setHypo] = React.useState(false);
  const [docs, setDocs] = React.useState([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState('');
  const active = React.useRef(null);
  React.useEffect(() => () => active.current?.abort(), []);
  async function request(args) {
    active.current?.abort();
    const controller = new AbortController();
    active.current = controller;
    setBusy(true);
    setError('');
    try {
      const result = await load(args, controller.signal);
      if (controller.signal.aborted) return;
      if (result.item)
        setDocs((previous) => [
          ...previous.filter((d) => d.label !== result.item.label),
          { ...result.item, checked: true },
        ]);
      else if (result.paths) {
        setMatches(result.paths);
        setTruncated(!!result.truncated);
      } else {
        setListing(result);
        setMatches(null);
        if (!result.directory) setHypo(result.hypo);
      }
    } catch (e) {
      if (!controller.signal.aborted) setError(e.message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  }
  const disabled = busy || submitting;
  const addDoc = (path) =>
    button('引用 ' + path, () => request({ file: path }), disabled, { key: path });
  const parent = listing?.directory?.split('/').slice(0, -1).join('/') ?? '';
  const ids = docs.filter((d) => d.checked).map((d) => d.id);
  const panel = h(
    'details',
    {
      onToggle: (e) => {
        if (e.target === e.currentTarget && e.currentTarget.open && !listing && !active.current)
          void request({ directory: '' });
      },
    },
    h('summary', null, ids.length ? '项目文档 · 已选 ' + ids.length + ' 份' : '项目文档'),
    h(
      'div',
      { className: 'sihq-launch-sources' },
      listing && h('small', null, '当前目录 · ' + (listing.directory || '.')),
      listing?.directory && button('上一级目录', () => request({ directory: parent }), disabled),
      listing &&
        h(
          'div',
          {
            style: {
              display: 'flex',
              gap: 4,
              flexWrap: 'wrap',
              maxHeight: '12rem',
              overflow: 'auto',
            },
          },
          listing.entries.map((entry) => {
            const path = [listing.directory, entry.name].filter(Boolean).join('/');
            return entry.type === 'directory'
              ? button(entry.name + '/', () => request({ directory: path }), disabled, {
                  key: path,
                })
              : addDoc(path);
          }),
        ),
      listing?.truncated && h('small', null, '目录条目较多，可直接输入文档路径。'),
      listing &&
        h(
          'label',
          null,
          '文档路径、文件名' + (hypo ? '或功能关键词 ' : ' '),
          h('input', {
            value: term,
            onChange: (e) => setTerm(e.target.value),
            placeholder: '例如 docs/使用手册.md',
            onKeyDown: (e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!disabled && term.trim())
                  void request(
                    /\.(md|markdown)$/i.test(term.trim()) ? { file: term.trim() } : { query: term },
                  );
              }
            },
          }),
        ),
      listing &&
        button('按路径引用', () => request({ file: term.trim() }), disabled || !term.trim()),
      listing && button('按文件名查找', () => request({ query: term }), disabled || !term.trim()),
      matches && truncated && h('small', null, '已显示部分匹配结果，可缩小搜索范围。'),
      hypo &&
        button('用 hw 查找相关需求', () => request({ keyword: term }), disabled || !term.trim()),
      matches &&
        h(
          'section',
          { 'aria-label': '匹配的需求文档' },
          matches.length ? matches.map(addDoc) : '没有匹配的项目文档。',
        ),
      busy && h('small', { role: 'status' }, '正在读取项目文档…'),
      error &&
        h(
          'div',
          { role: 'alert' },
          error,
          ' ',
          !listing && button('重新读取目录', () => request({ directory: '' }), disabled),
        ),
      docs.map((d) =>
        h(
          'div',
          { key: d.id },
          h(Checkbox, {
            label: d.label,
            checked: d.checked,
            disabled: submitting,
            onChange: (checked) =>
              setDocs((previous) => previous.map((x) => (x.id === d.id ? { ...x, checked } : x))),
          }),
          h(Expandable, { summary: '查看文档原文' }, h('pre', { style: preStyle }, d.text)),
        ),
      ),
    ),
  );
  return { panel, busy, ids };
}
