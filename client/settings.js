import {
  backendKey,
  workflowRowId,
  isAgentStep,
  roleLabels,
  roles as fields,
} from '../dist/workflow/rules.js';
import { supportsRoute } from '../route-compatibility.js';
import { workflowDraft } from './drafts.js';
import { InstanceManager } from './instance-manager.js';
import { ModelFields, ProviderPicker } from './model-fields.js';
import { Actions, DraftConflicts, Expandable, button, h } from './ui.js';
import { TemplateEditor, ReviewPolicyField } from './workflow-editor.js';
import { CommandField, WorkflowList } from './workflow-list.js';
import { defaults, exampleCommand, instanceKey, newTemplate } from './workflow-model.js';
import React from 'react';

export function Settings({
  rpc,
  scope,
  catalog,
  loadProviders,
  instanceCheck,
  modelChoices,
  previewStep,
  stageTrial,
  editor,
  clearTrial,
}) {
  const snapshot = React.useSyncExternalStore(
    React.useCallback((listener) => scope.subscribe(listener), [scope]),
    React.useCallback(() => scope.getSnapshot(), [scope]),
  );
  const [edit, setEdit] = React.useState(editor.edit);
  const [committing, setSaving] = React.useState(false);
  const [validating, setValidating] = React.useState(false);
  const saving = committing || validating;
  const [notice, setNotice] = React.useState('');
  const latest = { ...defaults, ...snapshot.value };
  const [editingId, setEditing] = React.useState(editor.selection);
  const merged = workflowDraft(edit, latest, editingId);
  const draft = merged.value;
  React.useEffect(() => {
    editor.edit = edit;
    editor.selection = editingId;
  }, [editor, edit, editingId]);
  const editing =
    editingId &&
    (editingId === 'siliconhq' || draft.templates.some((t) => workflowRowId(t) === editingId))
      ? editingId
      : null;
  const template = draft.templates.find((t) => workflowRowId(t) === editing);
  const [discarding, setDiscarding] = React.useState(false);
  const [catalogProviders, setProviders] = React.useState(null);
  const [workflowCatalog, setWorkflowCatalog] = React.useState(null);
  const bases = catalogProviders ?? [];
  const [manage, setManage] = React.useState(false);
  const instanceEntries = workflowCatalog?.instanceEntries ?? [];
  const validInstances = instanceEntries.flatMap((row) => (row.instance ? [row.instance] : []));
  const providers = [
    ...validInstances.map((instance) => {
      const base = bases.find((p) => p.name === instance.backend);
      const bound = !instance.product || instance.product === base?.product;
      return {
        name: instanceKey(instance.id),
        instance,
        readRestriction: !bound ? '产品后端绑定已变化，请编辑实例' : base?.readRestriction,
        restriction: !bound ? '产品后端绑定已变化，请编辑实例' : base?.restriction,
        read: supportsRoute(base, instance, true),
        develop: supportsRoute(base, instance, false),
      };
    }),
    ...bases,
  ];
  const [providerError, setProviderError] = React.useState('');
  const [catalogError, setCatalogError] = React.useState('');
  const [reload, setReload] = React.useState(0);
  React.useEffect(() => {
    let generation = 0;
    const load = () => {
      const request = ++generation;
      return catalog(latest.agentInstances)
        .then((data) => {
          if (request === generation) {
            setWorkflowCatalog({
              revision: snapshot.revision,
              templates: data.templates,
              diagnostics: data.diagnostics ?? [],
              instanceEntries: data.instanceEntries,
            });
            setCatalogError('');
          }
        })
        .catch((error) => {
          if (request === generation) setCatalogError(error.message);
        });
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      generation++;
      window.removeEventListener('focus', load);
    };
  }, [catalog, reload, snapshot.revision]);
  const needsProviders = !!editing || manage;
  React.useEffect(() => {
    if (!needsProviders) return;
    let generation = 0;
    const load = async () => {
      const request = ++generation;
      try {
        const rows = await loadProviders();
        if (generation === request) {
          setProviders(rows);
          setProviderError('');
        }
      } catch (error) {
        if (generation === request) {
          setProviders(null);
          setProviderError(error.message);
        }
      }
    };
    load();
    window.addEventListener('focus', load);
    return () => {
      generation++;
      window.removeEventListener('focus', load);
    };
  }, [loadProviders, needsProviders, reload, snapshot.revision]);
  const currentCatalog = workflowCatalog;
  const catalogRefreshing = !currentCatalog || currentCatalog.revision !== snapshot.revision;
  const diagnostics = currentCatalog?.diagnostics ?? [];
  const saved = currentCatalog?.templates ?? [];
  const savedTemplate = saved.find((t) => t.id === editing);
  const invocation = savedTemplate ? exampleCommand(savedTemplate) : '';
  const stale = merged.conflicts.length > 0;
  function resolveDraft(choice) {
    const { value } = workflowDraft(edit, latest, editingId, choice);
    if (editingId !== 'siliconhq' && !value.templates.some((t) => workflowRowId(t) === editingId)) {
      open(null);
      return;
    }
    setEdit({ base: latest, value, revision: snapshot.revision });
    clearTrial();
    setNotice('已合并配置。可以继续编辑，点击保存后生效。');
  }
  function change(key, value) {
    clearTrial();
    setNotice('');
    setEdit((current) => ({
      base: latest,
      revision: snapshot.revision,
      value: { ...workflowDraft(current, latest, editingId).value, [key]: value },
    }));
  }
  function open(id) {
    clearTrial();
    setEdit(null);
    setNotice('');
    setDiscarding(false);
    setEditing(id);
  }
  function create(base) {
    const next = newTemplate(base, latest, saved);
    if (!next) return;
    open(next.id);
    setEdit({
      base: latest,
      revision: snapshot.revision,
      value: { ...latest, templates: [...latest.templates, next] },
    });
  }
  async function write(ops, revision, message) {
    if (committing || !snapshot.writable) return false;
    setSaving(true);
    try {
      await scope.mutate(ops, revision);
      setNotice(message);
      return true;
    } catch (error) {
      setNotice('保存失败：' + error.message);
      return false;
    } finally {
      setSaving(false);
    }
  }
  function unavailable(flow) {
    const routes = flow
      ? flow.steps.filter(isAgentStep).map((s) => [s.name, s.backend, s.kind !== 'develop'])
      : [...fields, 'feedback'].map((role) => [
          roleLabels[role] || '反馈',
          draft[role],
          role !== 'developer',
        ]);
    return routes.flatMap(([label, backend, read]) => {
      const entry = providers.find((p) => p.name === backendKey(backend));
      return (read ? entry?.read : entry?.develop)
        ? []
        : [label + '（' + backendKey(backend) + '）'];
    });
  }
  function builtinDraft() {
    const { templates, selectedTemplate, agentInstances, ...settings } = draft;
    return settings;
  }
  async function tryDraft() {
    if (stale || saving) return;
    setValidating(true);
    try {
      const normalized = template && (await rpc('validateTemplate', { template }));
      const trial = normalized
        ? { template: normalized, maxRepairs: draft.maxRepairs, reviewPolicy: draft.reviewPolicy }
        : builtinDraft();
      if (!normalized) await rpc('validateRoles', trial);
      const missing = unavailable(normalized);
      if (catalogProviders && missing.length)
        throw new Error('后端未就绪：' + missing.join('、') + '。请启用或更换执行者后试用。');
      stageTrial(editing, trial, validInstances);
      setNotice('草稿可试用。回到目标项目的聊天，输入 /sihq，选择带「草稿」标记的流程。');
    } catch (error) {
      setNotice(error.message);
    } finally {
      setValidating(false);
    }
  }
  async function save() {
    if (!edit || stale || saving) return;
    setValidating(true);
    try {
      let ops;
      if (template) {
        const normalized = await rpc('validateTemplate', { template });
        const index = latest.templates.findIndex((t) => workflowRowId(t) === editing);
        const templates =
          index >= 0
            ? latest.templates.map((t, i) => (i === index ? normalized : t))
            : [...latest.templates, normalized];
        ops = [{ op: 'set', path: ['templates'], value: templates }];
      } else {
        await rpc('validateRoles', builtinDraft());
        ops = Object.keys(defaults)
          .filter(
            (k) =>
              !['templates', 'selectedTemplate', 'agentInstances'].includes(k) &&
              draft[k] !== latest[k],
          )
          .map((k) => ({ op: 'set', path: [k], value: draft[k] }));
      }
      const missing = unavailable(template);
      if (
        await write(
          ops,
          snapshot.revision,
          '已保存「' +
            (template?.name.trim() ?? 'SiliconHQ 开发流程') +
            '」。' +
            (!catalogProviders
              ? '执行者状态将在启动前检查。'
              : missing.length
                ? '后端未就绪：' + missing.join('、') + '。'
                : '在聊天框输入 /sihq 即可选择。'),
        )
      ) {
        clearTrial();
        setEdit(null);
        setDiscarding(false);
        setEditing(null);
      }
    } catch (error) {
      setNotice('保存失败：' + error.message);
    } finally {
      setValidating(false);
    }
  }
  if (snapshot.status !== 'ready') return h('p', null, '正在读取 DSH 角色设置…');
  if (manage)
    return h(InstanceManager, {
      config: latest,
      entries: instanceEntries,
      rpc,
      revision: snapshot.revision,
      writable: snapshot.writable && !catalogRefreshing,
      busy: saving,
      providers: bases,
      loadingProviders: catalogProviders === null,
      providerError: providerError || catalogError,
      refreshProviders: () => setReload((n) => n + 1),
      instanceCheck,
      modelChoices,
      write,
      notice,
      notify: setNotice,
      back: () => {
        setManage(false);
        setNotice('');
      },
    });
  return h(
    'section',
    {
      'data-sihq-editor': editing ? '' : undefined,
      style: { display: 'grid', gap: 12, maxWidth: 760, minWidth: 0 },
    },
    h(
      Actions,
      { style: { justifyContent: 'space-between' } },
      h('h3', { style: { margin: 0 } }, 'SiliconHQ 工作流'),
      !editing &&
        button(
          '管理 Agent 实例',
          () => {
            setManage(true);
            setNotice('');
          },
          saving,
          { variant: 'outline', size: 'sm' },
        ),
    ),
    !editing &&
      catalogError &&
      h(
        'p',
        { role: 'alert' },
        '读取工作流失败：' + catalogError,
        ' ',
        button('重新加载', () => setReload((n) => n + 1)),
      ),
    !editing &&
      h(WorkflowList, {
        rpc,
        repairLimit: latest.maxRepairs,
        saved,
        rawTemplates: latest.templates,
        diagnostics: diagnostics.filter((d) => d.index >= 0),
        summaries: Object.fromEntries(
          (currentCatalog?.templates ?? []).map((t) => [t.id, t.summary]),
        ),
        selected: latest.selectedTemplate.trim(),
        revision: snapshot.revision,
        disabled: !snapshot.writable || saving || catalogRefreshing,
        open,
        create,
        write,
        notice,
        notify: setNotice,
        busy: saving,
      }),
    editing &&
      h(
        React.Fragment,
        null,
        h('h4', null, '编辑工作流 · ' + (template?.name ?? 'SiliconHQ 开发流程')),
        h(
          Actions,
          { sticky: true, role: 'group', 'aria-label': '工作流编辑操作' },
          button(
            committing ? '保存中…' : '保存',
            save,
            !edit || stale || saving || !snapshot.writable,
            { variant: 'primary' },
          ),
          edit && button('在聊天中试用草稿', tryDraft, stale || saving, { variant: 'outline' }),
          button(
            edit ? '取消' : '返回列表',
            () => (edit ? setDiscarding(true) : open(null)),
            saving,
            { variant: 'ghost' },
          ),
        ),
        discarding &&
          h(
            'div',
            { role: 'group', 'aria-label': '放弃未保存修改' },
            h('p', null, '这次修改尚未保存。'),
            h(
              Actions,
              null,
              button('继续编辑', () => setDiscarding(false)),
              button('放弃修改并返回', () => open(null), saving),
            ),
          ),
        notice && h('p', { role: 'status' }, notice),
        stale &&
          h(DraftConflicts, {
            conflicts: merged.conflicts,
            resolve: resolveDraft,
            disabled: saving,
          }),
        providerError && h('p', { role: 'alert' }, '无法读取 DSH 执行者：' + providerError),
        h(
          'div',
          null,
          button('刷新执行者', () => setReload((n) => n + 1), saving, {
            variant: 'ghost',
            size: 'sm',
          }),
        ),
        template &&
          h(TemplateEditor, {
            key: editing,
            template,
            update: (patch) =>
              change(
                'templates',
                draft.templates.map((t) => (workflowRowId(t) === editing ? { ...t, ...patch } : t)),
              ),
            previewStep,
            providers,
            modelChoices,
            disabled: !snapshot.writable || saving || stale,
          }),
        editing === 'siliconhq' &&
          h('p', null, '依次计划、开发、独立审查。审查要求修改时，回到开发角色。'),
        editing === 'siliconhq' &&
          h(
            'fieldset',
            {
              disabled: !snapshot.writable || saving || stale,
              style: { display: 'grid', gap: 12, border: 0, padding: 0 },
            },
            [...fields, 'feedback'].map((role) =>
              h(
                'fieldset',
                {
                  key: role,
                  style: { display: 'grid', gap: 6, padding: 10 },
                },
                h('legend', null, roleLabels[role] || '用尽修复次数后的反馈执行者'),
                h(ProviderPicker, {
                  value: draft[role],
                  set: (v) => {
                    change(role, v);
                    change(role + 'Llm', '');
                    change(role + 'Model', '');
                    change(role + 'ReasoningEffort', '');
                  },
                  providers,
                  readOnly: role !== 'developer',
                }),
                h(
                  Expandable,
                  {
                    summary: [
                      '模型和思考强度',
                      draft[role + 'Model'],
                      draft[role + 'ReasoningEffort'],
                    ]
                      .filter(Boolean)
                      .join(' · '),
                  },
                  h(ModelFields, {
                    key: draft[role],
                    backend: draft[role],
                    providers,
                    provider: draft[role + 'Llm'],
                    model: draft[role + 'Model'],
                    reasoningEffort: draft[role + 'ReasoningEffort'],
                    load: modelChoices,
                    patch: (values) => {
                      for (const [key, value] of Object.entries(values))
                        change(
                          role +
                            {
                              provider: 'Llm',
                              model: 'Model',
                              reasoningEffort: 'ReasoningEffort',
                            }[key],
                          value,
                        );
                    },
                  }),
                ),
              ),
            ),
            h(ReviewPolicyField, {
              value: draft.reviewPolicy,
              onChange: (v) => change('reviewPolicy', v),
            }),
            h(
              'label',
              null,
              '当前 profile 所有流程的修复次数总上限 ',
              h(
                'select',
                {
                  value: draft.maxRepairs,
                  onChange: (e) => change('maxRepairs', Number(e.target.value)),
                },
                [0, 1, 2].map((n) => h('option', { value: n, key: n }, n)),
              ),
            ),
          ),
        h('p', null, 'fork 继承父会话已完成轮次的历史和预设，仅用于开发。spawn 从新会话开始。'),
        !edit && invocation && h(CommandField, { command: invocation, notify: setNotice }),
      ),
  );
}
