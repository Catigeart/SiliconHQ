import { workflowRowId, builtinSequenceSummary } from '../dist/workflow/rules.js';
import { ActionMenu, Actions, button, h, panelStyle } from './ui.js';
import { ImportWorkflow, downloadWorkflow } from './workflow-import.js';
import { RowRepair } from './row-repair.js';
import { exampleCommand } from './workflow-model.js';
import React from 'react';

export function CommandField({ command, notify }) {
  return h(
    Actions,
    { style: { alignItems: 'end' } },
    h(
      'label',
      { style: { display: 'grid', flex: '1 1 14rem', gap: 4, minWidth: 0 } },
      '聊天调用指令',
      h('input', {
        readOnly: true,
        value: command,
        onFocus: (e) => e.target.select(),
      }),
    ),
    button('复制调用指令', async () => {
      try {
        await navigator.clipboard.writeText(command);
        notify('已复制调用指令。');
      } catch {
        notify('请选择上方指令并复制。');
      }
    }),
  );
}

function WorkflowRepair({ row, raw, revision, templates, selected, rpc, write, disabled, open }) {
  function clearMissingInputs(draft) {
    const seen = new Set();
    for (const step of draft.steps) {
      if (Array.isArray(step.inputs)) step.inputs = step.inputs.filter((id) => seen.has(id));
      if (step.returnTo && !seen.has(step.returnTo)) {
        delete step.returnTo;
        step.maxRepairs = 0;
      }
      seen.add(step.id);
    }
    return draft;
  }
  async function save(value, expected) {
    const next = [...templates];
    let newId;
    if (value === undefined) next.splice(row.index, 1);
    else {
      const fixed = await rpc('validateTemplate', { template: value });
      if (next.some((t, i) => i !== row.index && workflowRowId(t) === fixed.id))
        throw new Error('流程 ID 已被占用，请另取一个 ID。');
      next[row.index] = fixed;
      newId = fixed.id;
    }
    const ops = [{ op: 'set', path: ['templates'], value: next }];
    if (
      selected === row.id &&
      selected !== 'siliconhq' &&
      !next.some((t) => workflowRowId(t) === selected)
    )
      ops.push({ op: 'set', path: ['selectedTemplate'], value: newId || 'siliconhq' });
    return write(ops, expected, value === undefined ? '已删除损坏的工作流。' : '已保存修复。');
  }
  return h(RowRepair, {
    title: row.name,
    noun: '工作流',
    diagnostic: row.diagnostic,
    raw,
    revision,
    disabled,
    openEditor: row.editable ? () => open(row.id) : undefined,
    deleteText:
      '确认从配置中删除该工作流？历史记录会保留。' +
      (selected === row.id ? '如果删除当前默认流程，将使用内置流程。' : ''),
    helperLabel: '移除失效的输入和退回引用',
    transform: clearMissingInputs,
    save,
  });
}

export function WorkflowList({
  rpc,
  repairLimit,
  saved,
  rawTemplates,
  diagnostics,
  summaries,
  selected,
  revision,
  disabled,
  open,
  create,
  write,
  notice,
  notify,
  busy,
}) {
  const [panel, setPanel] = React.useState(null);
  const [seed, setSeed] = React.useState('');
  const [replacement, setReplacement] = React.useState('');
  async function remove(t) {
    if (
      panel?.kind !== 'delete' ||
      panel.id !== t.id ||
      panel.revision !== revision ||
      workflowRowId(rawTemplates[t.index]) !== t.id ||
      (selected === t.id && !saved.some((o) => o.id === replacement && o.id !== t.id))
    )
      return;
    const ops = [
      {
        op: 'set',
        path: ['templates'],
        value: rawTemplates.filter((_, index) => index !== t.index),
      },
    ];
    if (t.id === selected)
      ops.push({
        op: 'set',
        path: ['selectedTemplate'],
        value: replacement,
      });
    if (await write(ops, panel.revision, '已删除「' + t.name + '」。')) setPanel(null);
  }
  return h(
    'div',
    { style: { display: 'grid', gap: 8 } },
    h('p', null, '在项目聊天输入 ', h('code', null, '/sihq'), '，回车后选择要运行的工作流。'),
    h(
      Actions,
      null,
      button('新建工作流', () => setPanel({ kind: 'create' }), disabled, {
        variant: panel?.kind === 'create' || panel?.kind === 'import' ? 'outline' : 'primary',
        'aria-expanded': panel?.kind === 'create',
      }),
      button('导入工作流', () => setPanel({ kind: 'import' }), disabled, {
        variant: 'outline',
        'aria-expanded': panel?.kind === 'import',
      }),
    ),
    panel?.kind === 'import' &&
      h(ImportWorkflow, {
        revision,
        repairLimit,
        rpc,
        disabled,
        write,
        close: () => setPanel(null),
      }),
    panel?.kind === 'create' &&
      h(
        'fieldset',
        null,
        h('legend', null, '选择新工作流的起点'),
        h(
          'label',
          null,
          '起点 ',
          h(
            'select',
            { value: seed, onChange: (e) => setSeed(e.target.value) },
            h('option', { value: '' }, '空白流程'),
            h('option', { value: 'siliconhq' }, '开发与审查预设'),
          ),
        ),
        h(
          Actions,
          null,
          button('开始编辑', () => create(seed || null), disabled, { variant: 'primary' }),
          button('取消', () => setPanel(null), false, { variant: 'ghost' }),
        ),
      ),
    diagnostics.map((row) =>
      h(WorkflowRepair, {
        key: 'repair-' + row.index + '-' + row.id,
        row,
        raw: rawTemplates[row.index],
        revision,
        templates: rawTemplates,
        selected,
        rpc,
        write,
        disabled,
        open,
      }),
    ),
    saved.map((t) => {
      const builtin = t.id === 'siliconhq';
      const showingCommand = panel?.kind === 'command' && panel.id === t.id;
      /** @type {Parameters<typeof ActionMenu>[0]['items']} */
      const items = [
        {
          label: showingCommand ? '收起调用指令' : '查看调用指令',
          onClick: () => setPanel(showingCommand ? null : { kind: 'command', id: t.id }),
        },
        {
          label: builtin ? '从开发预设新建' : '复制工作流',
          disabled,
          onClick: () => create(t.id),
        },
        { label: '导出工作流', onClick: () => downloadWorkflow(rpc, t, notify) },
      ];
      if (t.id !== selected)
        items.push({
          label: '设为默认',
          disabled,
          onClick: () =>
            write(
              [{ op: 'set', path: ['selectedTemplate'], value: t.id }],
              revision,
              '默认流程已设为「' + t.name + '」。',
            ),
        });
      if (!builtin)
        items.push({
          label: '删除工作流',
          disabled,
          danger: true,
          onClick: () => {
            setReplacement('');
            setPanel({ kind: 'delete', id: t.id, revision });
          },
        });
      return h(
        'article',
        { key: t.id, 'aria-label': t.name, style: panelStyle },
        h(
          Actions,
          { style: { justifyContent: 'space-between' } },
          h(
            'div',
            { style: { flex: '1 1 14rem', minWidth: 0, overflowWrap: 'anywhere' } },
            h('strong', null, t.name),
            t.id === selected && ' · 默认',
            builtin && ' · 内置',
            h(
              'small',
              { style: { display: 'block' } },
              summaries[t.id] ?? (builtin ? builtinSequenceSummary(() => '', repairLimit) : t.name),
            ),
          ),
          h(
            Actions,
            null,
            button(disabled && !busy ? '查看' : '编辑', () => open(t.id), busy, {
              variant: 'outline',
              size: 'sm',
            }),
            h(ActionMenu, { disabled: busy, items }),
          ),
        ),
        showingCommand && h(CommandField, { command: exampleCommand(t), notify }),
        panel?.kind === 'delete' &&
          panel.id === t.id &&
          h(
            'fieldset',
            null,
            h('legend', null, '删除「' + t.name + '」？'),
            h('p', null, '删除后无法再发起这个工作流。已有运行和历史记录会保留。'),
            t.id === selected &&
              h(
                'label',
                null,
                '新的默认工作流 ',
                h(
                  'select',
                  {
                    value: replacement,
                    onChange: (e) => setReplacement(e.target.value),
                  },
                  h('option', { value: '' }, '请选择接替的流程'),
                  saved
                    .filter((o) => o.id !== t.id)
                    .map((o) => h('option', { key: o.id, value: o.id }, o.name)),
                ),
              ),
            revision !== panel.revision &&
              h('p', { role: 'alert' }, '列表已更新。请取消并重新选择要删除的流程。'),
            h(
              Actions,
              null,
              button('取消删除', () => setPanel(null), busy),
              button(
                '确认删除',
                () => remove(t),
                disabled || revision !== panel.revision || (t.id === selected && !replacement),
                { variant: 'outline' },
              ),
            ),
          ),
      );
    }),
    notice && h('p', { role: 'status' }, notice),
  );
}
