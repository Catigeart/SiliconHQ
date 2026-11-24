import { useProjectDocuments } from './project-documents.js';
import React from 'react';
import { Checkbox } from '@deepseek-ai/dsh-client-ui-primitives';
import { button, h, preStyle } from './ui.js';

/** Preview only the references explicitly selected for this launch or continuation. */
export function useLaunchContext(loadSources, diffRequired, submitting, loadDocuments) {
  const documents = useProjectDocuments(loadDocuments, submitting);
  const [open, setOpen] = React.useState(Boolean(diffRequired));
  const [request, setRequest] = React.useState(() => (diffRequired ? { includeDiff: true } : null));
  const [response, setResponse] = React.useState({ request: null, items: [], error: '' });
  const [ids, setIds] = React.useState([]);
  const [references, setReferences] = React.useState({});
  const inflight = React.useRef(new Map());
  const ensure = (id) => {
    if (inflight.current.has(id)) return;
    inflight.current.set(id, true);
    setReferences((previous) => ({ ...previous, [id]: { loading: true } }));
    loadSources(false, id)
      .then((item) => {
        setReferences((previous) => ({ ...previous, [id]: { text: item.text } }));
      })
      .catch((error) => {
        inflight.current.delete(id);
        setReferences((previous) => ({ ...previous, [id]: { error: error.message } }));
      });
  };
  const loading = request !== response.request;
  const hasDiff = response.items.some((item) => item.kind === 'diff');

  React.useEffect(() => {
    if (!request) return;
    let active = true;
    loadSources(request.includeDiff)
      .then((result) => {
        if (!active) return;
        const items = result.items;
        setIds((previous) => {
          const available = new Set(items.map((item) => item.id));
          const selected = previous.filter((id) => available.has(id));
          const diff = items.find((item) => item.kind === 'diff');
          if (request.includeDiff && diff && !selected.includes(diff.id)) selected.push(diff.id);
          return selected;
        });
        setResponse({ request, items, error: result.diffError || '' });
      })
      .catch((error) => {
        if (active) setResponse((previous) => ({ ...previous, request, error: error.message }));
      });
    return () => {
      active = false;
    };
  }, [loadSources, request]);

  function toggle(event) {
    if (event.target !== event.currentTarget) return;
    const expanded = event.currentTarget.open;
    setOpen(expanded);
    if (expanded && !request) setRequest({ includeDiff: Boolean(diffRequired) });
  }

  const panel = h(
    'details',
    { open, onToggle: toggle, className: 'sihq-launch-context' },
    h('summary', null, '引用上下文（已选 ' + (ids.length + documents.ids.length) + '）'),
    h(
      'div',
      { role: 'group', 'aria-label': '发送给本轮 Agent 的内容', className: 'sihq-launch-sources' },
      documents.panel,
      response.items.map((item) =>
        h(
          'div',
          { key: item.id },
          h(Checkbox, {
            label: item.label,
            checked: ids.includes(item.id),
            disabled: submitting || loading || (diffRequired && item.kind === 'diff'),
            onChange: (checked) => {
              if (checked) ensure(item.id);
              setIds((previous) =>
                checked ? [...previous, item.id] : previous.filter((id) => id !== item.id),
              );
            },
          }),
          h(
            'details',
            {
              onToggle: (event) => {
                if (event.target === event.currentTarget && event.currentTarget.open)
                  ensure(item.id);
              },
            },
            h('summary', null, '查看引用内容'),
            references[item.id]?.error
              ? h(
                  'span',
                  { role: 'alert' },
                  references[item.id].error,
                  button('重新读取', () => ensure(item.id), submitting),
                )
              : h('pre', { style: preStyle }, references[item.id]?.text ?? '正在读取…'),
          ),
        ),
      ),
      !hasDiff &&
        button(
          response.error ? '重新载入' : '载入并引用当前 Git diff',
          () => setRequest({ includeDiff: response.error ? request.includeDiff : true }),
          submitting || loading,
        ),
      h(
        'small',
        { role: 'status' },
        loading
          ? '正在读取可引用内容…'
          : response.error ||
              (request && !response.items.length ? '本会话暂无可引用的消息或报告。' : ''),
      ),
    ),
  );
  let blocked = '';
  if (loading || documents.busy) blocked = '正在读取本轮可引用的内容。';
  else if (ids.some((id) => references[id]?.error))
    blocked = '选中的引用未能读取，请重试或取消勾选。';
  else if (ids.some((id) => references[id]?.loading)) blocked = '正在读取所选引用。';
  else if (diffRequired && !hasDiff) blocked = '此工作流需要 Git diff，请在引用上下文中重新载入。';
  return { ids: [...ids, ...documents.ids], panel, blocked };
}
