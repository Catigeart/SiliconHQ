import { agentName } from '../dist/workflow/rules.js';
import { mergeDraft, sameInstanceRoute } from './drafts.js';
import { ModelFields } from './model-fields.js';
import { RowRepair } from './row-repair.js';
import { ActionMenu, Actions, DraftConflicts, button, h, panelStyle } from './ui.js';
import { instanceKey, instanceSummary, replaceUsages, usages } from './workflow-model.js';
import { supportsRoute } from '../route-compatibility.js';
import React from 'react';

function InstanceDetails({ instance, refs, check, edit, remove, writable, busy }) {
  const [result, setResult] = React.useState(null);
  const [pending, setPending] = React.useState('');
  const [error, setError] = React.useState('');
  const request = React.useRef(null);
  React.useEffect(() => () => request.current?.abort(), [instance.id]);
  const labels = {
    pass: '通过',
    fail: '失败',
    inherited: '沿用默认',
    unconfirmed: '待实测',
    skipped: '未执行',
  };
  async function run(live) {
    if (request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setPending(live ? '正在等待测试回复…' : '正在读取配置…');
    setError('');
    try {
      const value = await check({ id: instance.id, live }, controller.signal);
      if (!controller.signal.aborted) setResult(value);
    } catch (e) {
      if (!controller.signal.aborted) {
        setError(e.message);
        setResult(null);
      }
    } finally {
      request.current = null;
      if (!controller.signal.aborted) setPending('');
    }
  }
  return h(
    'div',
    null,
    h(
      Actions,
      { style: { justifyContent: 'space-between' } },
      h(
        'div',
        {
          style: {
            display: 'grid',
            gap: 4,
            flex: '1 1 14rem',
            minWidth: 0,
            overflowWrap: 'anywhere',
          },
        },
        h('strong', null, instance.name),
        h('small', null, instanceSummary(instance)),
        h('small', null, '使用位置：' + (refs.map((r) => r.label).join('、') || '尚未使用')),
      ),
      h(
        Actions,
        null,
        button(writable ? '编辑' : '查看', edit, busy, { variant: 'outline', size: 'sm' }),
        h(ActionMenu, {
          disabled: busy,
          items: [
            { label: '检查配置', onClick: () => run(false), disabled: !!pending },
            { label: '删除实例', onClick: remove, disabled: !writable, danger: true },
          ],
        }),
      ),
    ),
    pending && h('p', { role: 'status' }, pending),
    error && h('p', { role: 'alert' }, error),
    result &&
      h(
        'div',
        null,
        h(
          'ul',
          { 'aria-label': '实例检查结果' },
          result.checks.map((row) =>
            h('li', { key: row.label }, row.label + ' · ' + labels[row.state] + ' · ' + row.detail),
          ),
        ),
        result.checks.slice(0, 2).every((row) => row.state !== 'fail') &&
          h(
            React.Fragment,
            null,
            h(
              'p',
              null,
              '实际测试会在临时空目录中发送一次简短请求，可能消耗模型额度。DSH 会保存独立的测试会话记录。外部执行者沿用其工具权限。',
            ),
            button('实际委派测试', () => run(true), !!pending, { variant: 'outline', size: 'sm' }),
          ),
      ),
  );
}

export function InstanceManager({
  config,
  entries,
  rpc,
  revision,
  writable,
  busy,
  providers,
  loadingProviders,
  providerError,
  refreshProviders,
  instanceCheck,
  modelChoices,
  write,
  back,
  notice,
  notify,
}) {
  const [draft, setDraft] = React.useState(null);
  const [deleting, setDeleting] = React.useState(null);
  const [replacement, setReplacement] = React.useState('');
  const rawRows = config.agentInstances;
  const rows = entries.flatMap((row) => (row.instance ? [row.instance] : []));
  const indexOfInstance = (id) => entries.find((row) => row.instance?.id === id)?.index;
  const target = deleting && rows.find((i) => i.id === deleting.id);
  const used = target ? usages(config, instanceKey(target.id)) : [];
  const currentItem = draft && rows.find((row) => row.id === draft.value.id);
  const merged = draft && mergeDraft(draft.base, draft.value, currentItem);
  const stale = !!merged?.conflicts.length || (!!deleting && deleting.revision !== revision);
  function resolveDraft(choice) {
    const value = mergeDraft(draft.base, draft.value, currentItem, choice).value;
    setDraft(value ? { base: currentItem, revision, value } : null);
  }
  const disabled = !writable || busy;
  function edit(value) {
    setDeleting(null);
    notify('');
    setDraft({ revision, base: rows.find((row) => row.id === value.id), value: { ...value } });
  }
  function create(backend) {
    edit({ id: crypto.randomUUID(), name: '', backend });
  }
  function patch(p) {
    setDraft((old) => ({
      base: currentItem,
      revision,
      value: { ...mergeDraft(old.base, old.value, currentItem).value, ...p },
    }));
  }
  function compatible(route, refs) {
    const base = providers.find((p) => p.name === route.backend);
    return (
      supportsRoute(base, route, undefined) &&
      refs.every((ref) => supportsRoute(base, route, ref.read))
    );
  }
  async function save() {
    if (stale || !merged?.value) return;
    const i = merged.value;
    const name = i.name.trim(),
      base = providers.find((p) => p.name === i.backend);
    const index = indexOfInstance(i.id);
    if (
      !name ||
      name.length > 80 ||
      rawRows.some(
        (row, n) => n !== index && typeof row?.name === 'string' && row.name.trim() === name,
      )
    ) {
      notify('请填写唯一的实例名称，最多 80 个字符。');
      return;
    }
    const refs = usages(config, instanceKey(i.id));
    const unchangedRoute = sameInstanceRoute(currentItem, i);
    if (!unchangedRoute && i.product && i.product !== base?.product) {
      notify('产品后端绑定已变化，请重新选择基础后端。');
      return;
    }
    if (!unchangedRoute && !compatible(i, refs)) {
      notify('请核对后端是否启用，以及模型覆盖、DSH 预设与步骤读写权限是否兼容。');
      return;
    }
    if (!unchangedRoute && i.reasoningEffort && !i.model && !base?.routeDefaults?.model) {
      notify('选择模型后再设置思考强度。');
      return;
    }
    const product = unchangedRoute ? i.product : base?.product;
    const item = {
      id: i.id,
      name,
      backend: i.backend,
      ...(product && { product }),
    };
    for (const k of ['provider', 'model', 'reasoningEffort', 'agentPreset'])
      if (i[k]?.trim()) item[k] = i[k].trim();
    const next = [...rawRows];
    if (index === undefined) {
      if (entries.some((row) => row.id === i.id)) {
        notify('该 ID 已存在于需要修复的实例中。请先修复该实例。');
        return;
      }
      next.push(item);
    } else next[index] = item;
    if (
      await write(
        [{ op: 'set', path: ['agentInstances'], value: next }],
        revision,
        '已保存「' + name + '」。',
      )
    )
      setDraft(null);
  }
  async function remove() {
    if (stale || !target) return;
    const next = rows.filter((i) => i.id !== target.id);
    if (used.length && !next.some((i) => i.id === replacement && compatible(i, used))) return;
    const index = indexOfInstance(target.id);
    if (index === undefined) return;
    const ops = [
      { op: 'set', path: ['agentInstances'], value: rawRows.filter((_, n) => n !== index) },
    ];
    ops.push(...replaceUsages(config, used, instanceKey(replacement)));
    if (await write(ops, deleting.revision, '已删除「' + target.name + '」。')) setDeleting(null);
  }
  const v = merged?.value ?? draft?.value;
  const refs = v ? usages(config, instanceKey(v.id)) : [];
  const backend = providers.find((p) => p.name === v?.backend);
  const initialBackend =
    providers.find((p) => p.registered !== false && p.name === 'spawn') ??
    providers.find((p) => p.registered !== false);
  const presets = backend?.presets ?? [];
  const selectedPreset = presets.find((p) => p.id === v?.agentPreset);
  async function repair(row, value, expected) {
    const next = [...rawRows];
    if (value === undefined) next.splice(row.index, 1);
    else
      next[row.index] = await rpc('validateInstanceRepair', {
        rows: rawRows,
        index: row.index,
        value,
      });
    if (row.id && !next.some((i) => typeof i?.id === 'string' && i.id.trim() === row.id)) {
      const refs = usages(config, instanceKey(row.id));
      if (refs.length)
        throw new Error(
          '仍被以下步骤引用，请保留原 ID 或先更换步骤的执行者：' +
            refs.map((r) => r.label).join('、'),
        );
    }
    return write(
      [{ op: 'set', path: ['agentInstances'], value: next }],
      expected,
      value === undefined ? '已删除此项实例。' : '已修复此项实例。',
    );
  }
  return h(
    'section',
    { 'data-sihq-editor': v ? '' : undefined, style: { display: 'grid', gap: 10 } },
    h(
      Actions,
      { sticky: !!v, style: { justifyContent: 'space-between' } },
      h('h3', { style: { margin: 0 } }, 'Agent 实例'),
      v
        ? h(
            Actions,
            null,
            writable &&
              button('保存实例', save, stale || disabled || !merged?.value, { variant: 'primary' }),
            button(
              writable ? '取消编辑' : '返回列表',
              () => {
                setDraft(null);
                notify('');
              },
              busy,
              { variant: 'ghost' },
            ),
          )
        : h(
            Actions,
            null,
            button(
              '新建 Agent 实例',
              () => create(initialBackend.name),
              disabled || !initialBackend,
              { variant: 'primary' },
            ),
            button('返回工作流', back, busy, { variant: 'ghost' }),
          ),
    ),
    notice && h('p', { role: 'status' }, notice),
    !v && h('h4', null, '我的命名实例'),
    !v &&
      !rawRows.length &&
      h('p', null, '还没有保存命名实例。点击「新建 Agent 实例」选择后端、模型和思考强度。'),
    !v &&
      entries
        .filter((row) => row.diagnostic)
        .map((row) =>
          h(RowRepair, {
            key: 'invalid-' + row.index + '-' + row.id,
            title: row.name + ' · 第 ' + (row.index + 1) + ' 项',
            noun: '实例',
            diagnostic: row.diagnostic,
            raw: rawRows[row.index],
            revision,
            disabled,
            openEditor: undefined,
            deleteText:
              '确认删除这项损坏的实例配置？其他同 ID 的项将保留，请核对使用该 ID 的工作流。',
            helperLabel: '为此项生成新 ID',
            transform: (draft) => {
              if (!draft || typeof draft !== 'object' || Array.isArray(draft))
                throw new Error('请先填写包含 name 和 backend 的实例配置对象。');
              return { ...draft, id: crypto.randomUUID() };
            },
            save: (value, expected) => repair(row, value, expected),
          }),
        ),
    !v &&
      rows.map((i) =>
        h(
          'article',
          { key: i.id, 'aria-label': i.name, style: panelStyle },
          h(InstanceDetails, {
            key: JSON.stringify(i),
            instance: i,
            refs: usages(config, instanceKey(i.id)),
            check: instanceCheck,
            edit: () => edit(i),
            remove: () => {
              setDeleting({ id: i.id, revision });
              setReplacement('');
              notify('');
            },
            writable,
            busy,
          }),
          target?.id === i.id &&
            h(
              'fieldset',
              null,
              h('legend', null, '删除「' + i.name + '」？'),
              used.length > 0 &&
                h(
                  'label',
                  null,
                  '替换上述引用为 ',
                  h(
                    'select',
                    {
                      value: replacement,
                      onChange: (e) => setReplacement(e.target.value),
                    },
                    h('option', { value: '' }, '请选择兼容的实例'),
                    rows
                      .filter((o) => o.id !== i.id && compatible(o, used))
                      .map((o) => h('option', { value: o.id, key: o.id }, o.name)),
                  ),
                ),
              h(
                'p',
                null,
                used.length
                  ? '可以先取消并另建实例，或先更改引用步骤。已有运行保留启动时的设置。'
                  : '此实例没有被工作流引用。',
              ),
              h(
                Actions,
                null,
                button('取消删除', () => setDeleting(null), busy, { variant: 'ghost' }),
                button('确认删除', remove, disabled || stale || (used.length > 0 && !replacement), {
                  variant: 'outline',
                }),
              ),
            ),
        ),
      ),
    !v &&
      h(
        'section',
        { 'aria-label': '已注册的基础后端' },
        h('h4', null, '已注册的基础后端'),
        providerError &&
          h(
            'div',
            { role: 'alert' },
            '读取 DSH 后端失败：' + providerError,
            ' ',
            button('重新加载', refreshProviders),
          ),
        !providerError &&
          !providers.length &&
          h(
            'p',
            { role: 'status' },
            loadingProviders ? '正在读取 DSH 后端…' : '当前 profile 没有已注册的后端。',
          ),
        providers.map((p) => {
          const direct = usages(config, p.name);
          const instances = rows.filter((i) => i.backend === p.name);
          return h(
            'article',
            {
              key: p.name,
              'aria-label': agentName(p.name),
              style: panelStyle,
            },
            h('strong', null, agentName(p.name)),
            h(
              'small',
              null,
              p.name +
                ' · ' +
                [p.registered === false && '未注册', p.read && '只读步骤', p.develop && '开发步骤']
                  .filter(Boolean)
                  .join('、'),
            ),
            p.restriction && h('small', null, p.restriction),
            direct.length > 0 &&
              h('span', null, '直接使用：' + direct.map((u) => u.label).join('、')),
            instances.length > 0 &&
              h('span', null, '命名实例：' + instances.map((i) => i.name).join('、')),
            h(
              'div',
              null,
              button(
                '基于此后端新建实例',
                () => create(p.name),
                disabled || p.registered === false,
                { variant: 'outline', size: 'sm' },
              ),
            ),
          );
        }),
      ),
    v &&
      h(
        'fieldset',
        { disabled: disabled || !!merged?.conflicts.length || !merged?.value, style: panelStyle },
        h(
          'legend',
          null,
          !writable ? '查看 Agent 实例' : currentItem ? '编辑 Agent 实例' : '新建 Agent 实例',
        ),
        h(
          'label',
          null,
          '实例名称 ',
          h('input', {
            value: v.name,
            maxLength: 80,
            onChange: (e) => patch({ name: e.target.value }),
          }),
        ),
        h(
          'label',
          null,
          '基础后端 ',
          h(
            'select',
            {
              value: v.backend,
              onChange: (e) =>
                patch({
                  backend: e.target.value,
                  product: providers.find((p) => p.name === e.target.value)?.product,
                  agentPreset: '',
                  provider: '',
                  model: '',
                  reasoningEffort: '',
                }),
            },
            !providers.some((p) => p.name === v.backend) &&
              h('option', { value: v.backend }, v.backend + '（不可用）'),
            providers.map((p) =>
              h(
                'option',
                {
                  key: p.name,
                  value: p.name,
                  disabled: !compatible({ backend: p.name }, refs),
                },
                agentName(p.name),
              ),
            ),
          ),
        ),
        v.product &&
          backend &&
          v.product !== backend.product &&
          h(
            'div',
            { role: 'alert' },
            '基础后端已从 ' + v.product + ' 换为 ' + (backend.product || backend.name) + '。 ',
            button(
              '使用当前注册的后端',
              () =>
                patch({
                  product: backend.product,
                  agentPreset: '',
                  provider: '',
                  model: '',
                  reasoningEffort: '',
                }),
              disabled,
            ),
          ),
        (backend?.agentPreset || v.agentPreset) &&
          h(
            'label',
            null,
            'DSH Agent 预设 ',
            h(
              'select',
              {
                value: v.agentPreset || '',
                onChange: (e) => patch({ agentPreset: e.target.value }),
              },
              h('option', { value: '' }, '按步骤默认'),
              v.agentPreset &&
                !selectedPreset &&
                h('option', { value: v.agentPreset, disabled: true }, v.agentPreset + '（不可用）'),
              presets.map((p) =>
                h(
                  'option',
                  {
                    key: p.id,
                    value: p.id,
                    disabled: !compatible({ ...v, agentPreset: p.id }, refs),
                  },
                  (p.name || p.id) + (p.name ? ' · ' + p.id : '') + (p.broken ? '（不可用）' : ''),
                ),
              ),
            ),
            backend?.presetError &&
              h('small', { role: 'alert' }, '读取 DSH 预设失败：' + backend.presetError),
            h(
              'small',
              null,
              !v.agentPreset
                ? '只读步骤使用 sihq-readonly，开发步骤使用 DSH 默认配置。'
                : v.agentPreset === 'sihq-readonly'
                  ? '只读工具：read、glob、grep。'
                  : [
                      selectedPreset?.description,
                      '用于开发步骤',
                      selectedPreset?.plugins?.length &&
                        'DSH 预设插件：' + selectedPreset.plugins.join('、'),
                    ]
                      .filter(Boolean)
                      .join(' · '),
            ),
          ),
        h(ModelFields, {
          key: v.backend,
          ...v,
          instanceEditor: true,
          providers,
          load: modelChoices,
          patch,
        }),
        !!refs.length &&
          h(
            'small',
            null,
            '保存后，下次运行这些步骤时生效：' + refs.map((r) => r.label).join('、'),
          ),
      ),
    !!merged?.conflicts.length &&
      h(DraftConflicts, { conflicts: merged.conflicts, resolve: resolveDraft, disabled }),
    draft &&
      !merged?.value &&
      !stale &&
      button('实例已在其他页面删除，返回列表', () => setDraft(null), busy),
    deleting && stale && h('p', { role: 'alert' }, '配置已更新，请重新发起删除以核对引用。'),
  );
}
