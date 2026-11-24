import { agentName, roleLabels } from '../dist/workflow/rules.js';
import { Actions, button, h, panelStyle } from './ui.js';
import { instanceKey } from './workflow-model.js';
import React from 'react';
import { verificationSummary } from './verification.js';

export function ImportWorkflow({ rpc, revision, write, close, repairLimit, disabled }) {
  const [file, setFile] = React.useState(null);
  const [info, setInfo] = React.useState(null);
  const [expected, setExpected] = React.useState(revision);
  const [choices, setChoices] = React.useState([]);
  const [instanceChoices, setInstanceChoices] = React.useState([]);
  const [clear, setClear] = React.useState([]);
  const [syncBudget, setSyncBudget] = React.useState(false);
  const [plan, setPlan] = React.useState(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState('');
  const stale = info && revision !== expected;
  const block = loading || disabled;
  async function selectFile(selected) {
    setFile(null);
    setInfo(null);
    setPlan(null);
    setError('');
    setSyncBudget(false);
    setClear([]);
    setInstanceChoices([]);
    if (!selected) return;
    setLoading(true);
    try {
      const value = JSON.parse(await selected.text());
      const next = await rpc('inspectImport', { file: value });
      setFile(value);
      setInfo(next);
      setExpected(revision);
      setChoices(
        next.backends.map(({ source, targets }) => (targets.includes(source) ? source : '')),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function selectInstance(id, mode) {
    const selected = new Map(instanceChoices);
    if (mode) selected.set(id, mode);
    else selected.delete(id);
    const nextChoices = [...selected];
    setError('');
    setLoading(true);
    try {
      const next = await rpc('inspectImport', { file, instanceChoices: nextChoices });
      const previous = new Map(info.backends.map((b, i) => [b.source, choices[i]]));
      setInfo(next);
      setInstanceChoices(nextChoices);
      setChoices(
        next.backends.map((b) => {
          const options = clear.includes(b.source) ? b.clearTargets : b.targets;
          const last = previous.get(b.source);
          return options.includes(last) ? last : options.includes(b.source) ? b.source : '';
        }),
      );
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function check() {
    setError('');
    setLoading(true);
    try {
      const result = await rpc('prepareImport', {
        file,
        choices: info.backends.map(({ source }, i) => [source, choices[i]]),
        syncBudget,
        clearOverrides: clear,
        instanceChoices,
      });
      setPlan(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  async function commit() {
    setLoading(true);
    try {
      if (await write(plan.ops, expected, '已导入「' + plan.name + '」。')) close();
    } finally {
      setLoading(false);
    }
  }
  return h(
    'fieldset',
    { style: panelStyle },
    h('legend', null, '导入工作流'),
    h(
      'label',
      null,
      '工作流文件 ',
      h('input', {
        type: 'file',
        accept: '.json,application/json',
        disabled: block,
        onChange: (e) => {
          const selected = e.target.files?.[0];
          e.target.value = '';
          selectFile(selected);
        },
      }),
    ),
    loading && h('p', { role: 'status' }, '处理中…'),
    error && h('p', { role: 'alert' }, error),
    stale && h('p', { role: 'alert' }, '配置已更新，请重新选择文件以获取最新预览。'),
    info &&
      h(
        React.Fragment,
        null,
        h('strong', null, plan?.name ?? info.name),
        h('span', null, info.steps.join(' → ')),
        info.verificationSteps?.length > 0 &&
          h(
            'section',
            { 'aria-label': '导入的验证命令' },
            h('strong', null, '运行此流程时执行的验证命令'),
            h(
              'ul',
              { style: { overflowWrap: 'anywhere' } },
              info.verificationSteps.map((step, i) =>
                h('li', { key: i }, verificationSummary(step)),
              ),
            ),
          ),
        info.instances.length > 0 && h('small', null, '引用的实例：' + info.instances.join('、')),
        !plan &&
          info.instanceMappings.map((row) =>
            h(
              'label',
              { key: row.id },
              '目标实例 · ' + row.name + ' ',
              h(
                'select',
                {
                  disabled: block || stale,
                  value: new Map(instanceChoices).get(row.id) ?? '',
                  onChange: (e) => selectInstance(row.id, e.target.value),
                },
                h('option', { value: '' }, '自动匹配，缺少时新建'),
                h('option', { value: 'new' }, '新建独立实例'),
                row.targets.map((t) =>
                  h('option', { key: t.id, value: instanceKey(t.id) }, t.label),
                ),
              ),
            ),
          ),
        !plan &&
          info.backends.map(
            (
              { source, targets, clearTargets, hasOverrides, sourceProducts, targetProducts },
              i,
            ) => {
              const clearing = clear.includes(source);
              const options = clearing ? clearTargets : targets;
              return h(
                'div',
                { key: source, style: { display: 'grid', gap: 4 } },
                h(
                  'label',
                  null,
                  '目标后端 · ' + [source, ...(sourceProducts ?? [])].join(' · ') + ' ',
                  h(
                    'select',
                    {
                      value: choices[i],
                      disabled: block,
                      onChange: (e) =>
                        setChoices(choices.map((v, n) => (n === i ? e.target.value : v))),
                    },
                    h('option', { value: '' }, '请选择目标后端'),
                    options.map((p) =>
                      h(
                        'option',
                        { key: p, value: p },
                        [agentName(p), targetProducts?.[p]].filter(Boolean).join(' · '),
                      ),
                    ),
                  ),
                ),
                hasOverrides &&
                  h(
                    'label',
                    null,
                    h('input', {
                      type: 'checkbox',
                      checked: clearing,
                      disabled: block,
                      onChange: (e) => {
                        const yes = e.target.checked;
                        setClear(yes ? [...clear, source] : clear.filter((v) => v !== source));
                        if (!(yes ? clearTargets : targets).includes(choices[i]))
                          setChoices(choices.map((v, n) => (n === i ? '' : v)));
                      },
                    }),
                    ' 重新绑定到所选后端，采用其产品、默认模型、强度和预设',
                  ),
                !options.length &&
                  h(
                    'small',
                    { role: 'status' },
                    !clearing && clearTargets.length
                      ? '勾选重新绑定，可选择当前 profile 的其他后端。'
                      : '没有兼容的目标。请启用所需后端或调整模型覆盖。',
                  ),
              );
            },
          ),
        !plan &&
          info.profileRepairLimit !== repairLimit &&
          h(
            'label',
            null,
            h('input', {
              type: 'checkbox',
              checked: syncBudget,
              disabled: block,
              onChange: (e) => setSyncBudget(e.target.checked),
            }),
            ' 同步当前 profile 所有工作流的修复总上限：' +
              repairLimit +
              ' → ' +
              info.profileRepairLimit,
          ),
        !plan &&
          h(
            Actions,
            null,
            button('检查导入', check, block || stale || choices.some((v) => !v), {
              variant: 'primary',
            }),
          ),
        plan &&
          h(
            'div',
            { style: panelStyle },
            h(
              'strong',
              null,
              info.kind === 'builtin'
                ? '将更新内置流程的角色设置'
                : '将新建工作流「' + plan.name + '」',
            ),
            plan.changes.map((r) =>
              h(
                'div',
                { key: r.role },
                (r.role === 'reviewPolicy' ? '审查策略' : roleLabels[r.role] || '反馈') +
                  '：' +
                  r.before +
                  ' → ' +
                  r.after,
              ),
            ),
            plan.created.length > 0 && h('div', null, '新建实例：' + plan.created.join('、')),
            plan.reused.length > 0 && h('div', null, '复用实例：' + plan.reused.join('、')),
            syncBudget &&
              h(
                'div',
                null,
                '整个 profile 的修复总上限：' + repairLimit + ' → ' + info.profileRepairLimit,
              ),
            h(
              Actions,
              null,
              button(
                info.kind === 'builtin' ? '应用到内置流程' : '确认导入',
                commit,
                block || stale,
                { variant: 'primary' },
              ),
              button('返回映射', () => setPlan(null), block, { variant: 'ghost' }),
            ),
          ),
      ),
    h(Actions, null, button('取消导入', close, block, { variant: 'ghost' })),
  );
}

export async function downloadWorkflow(rpc, template, notify) {
  try {
    const file = await rpc('exportWorkflow', { id: template.id });
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(file, null, 2)], { type: 'application/json' }),
    );
    const link = document.createElement('a');
    link.href = url;
    link.download =
      'sihq-' + template.name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') + '.sihq.json';
    try {
      document.body.append(link);
      link.click();
    } finally {
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  } catch (error) {
    notify('导出失败：' + error.message);
  }
}
