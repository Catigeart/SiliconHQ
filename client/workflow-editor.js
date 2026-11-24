import {
  agentName,
  backendKey,
  canShareInput,
  canUseAsCondition,
  canReturnToDeveloper,
  isAgentStep,
  isParallelRead,
  kinds,
  outcomes,
  referencesStep,
} from '../dist/workflow/rules.js';
import { ModelFields, ProviderPicker } from './model-fields.js';
import {
  IconChevronDownOutlineRegular,
  IconChevronUpOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives';
import { ActionMenu, Actions, Expandable, button, h, panelStyle, preStyle } from './ui.js';
import { defaultInstructions, newStep } from './workflow-model.js';
import { VerificationFields } from './verification.js';
import React from 'react';

const instructionExamples = {
  develop: [
    [
      '实现变更',
      '按任务范围修改代码并运行相关测试。在报告中列出修改的文件、验证结果和待解决的问题。',
    ],
  ],
  plan: [['制定计划', '阅读相关代码和已有约定。列出需要修改的位置、实施顺序和可验证的验收条件。']],
  review: [
    [
      '只读审查',
      '对照任务要求、可用的变更和验证报告逐项审查。指出需要修正的具体位置、原因和复验方法。',
    ],
  ],
  read: [
    ['只读分析', '查阅与任务相关的文件，列出具体位置和证据，并标明仍需确认的假设。'],
    [
      '验证失败分析',
      '根据提供的验证输出、退出码和相关代码定位失败原因。区分已观察到的事实和推测，给出复验建议。',
    ],
  ],
};

export function ReviewPolicyField({ value, onChange }) {
  return h(
    'label',
    null,
    '审查策略 ',
    h(
      'select',
      { value: value ?? 'strict', onChange: (e) => onChange(e.target.value) },
      h('option', { value: 'strict' }, '严格验收 · 所有缺陷都要修复'),
      h('option', { value: 'blocking' }, '按阻塞级别验收 · P2/P3 留作建议'),
    ),
  );
}

function StepPreview({ template, step, load }) {
  const [open, setOpen] = React.useState(false);
  const [references, setReferences] = React.useState(false);
  const humanReturn =
    !step.parallelGroup &&
    template.steps.slice(template.steps.indexOf(step) + 1).some((s) => s.kind === 'approval');
  const recheck = step.kind === 'review' && step.reviewPolicy === 'blocking';
  const [repair, setRepair] = React.useState('');
  const [result, setResult] = React.useState(null);
  const returns = template.steps.filter((s) => s.returnTo === step.id && s.maxRepairs > 0);
  const payload = JSON.stringify({
    step: {
      kind: step.kind,
      instructions: step.instructions,
      currentDiff: step.currentDiff,
      reviewPolicy: step.reviewPolicy,
      backend: step.backend,
      provider: step.provider,
      model: step.model,
      reasoningEffort: step.reasoningEffort,
    },
    inputs: step.inputs.map((id) => {
      const src = template.steps.find((s) => s.id === id);
      return { id, name: src?.name ?? id, kind: src?.kind };
    }),
    includeDiff: template.includeDiff,
    repair: returns.find((s) => 'auto:' + s.id === repair)?.kind,
    scenario: repair,
    references,
  });
  React.useEffect(() => {
    if (!open) return;
    let active = true;
    load(JSON.parse(payload))
      .then((data) => {
        if (active) setResult({ payload, ...data });
      })
      .catch((error) => {
        if (active) setResult({ payload, error: error.message });
      });
    return () => {
      active = false;
    };
  }, [load, open, payload]);
  return h(
    'details',
    { onToggle: (e) => setOpen(e.currentTarget.open) },
    h('summary', null, '查看 Agent 输入与输出要求'),
    open &&
      h(
        'div',
        { style: panelStyle },
        h(
          'small',
          null,
          '以下是插件提交给执行者的内容。〈 〉表示运行时填入的内容。执行者自己的系统指令由 DSH 或外部 Agent 管理。',
        ),
        (returns.length > 0 || humanReturn || recheck) &&
          h(
            'label',
            null,
            '预览输入 ',
            h(
              'select',
              { value: repair, onChange: (e) => setRepair(e.target.value) },
              h('option', { value: '' }, '正常执行'),
              ...returns.map((s) =>
                h('option', { key: s.id, value: 'auto:' + s.id }, s.name + '自动退回'),
              ),
              humanReturn && h('option', { value: 'human' }, '人工退回修改'),
              recheck && h('option', { value: 'recheck' }, '再次复审'),
            ),
          ),
        h(
          'label',
          null,
          h('input', {
            type: 'checkbox',
            checked: references,
            onChange: (e) => setReferences(e.target.checked),
          }),
          '包含启动时选取的参考资料',
        ),
        result?.payload !== payload
          ? '正在生成预览…'
          : result.error
            ? h('p', { role: 'alert' }, result.error)
            : h(
                React.Fragment,
                null,
                h('pre', { style: preStyle }, result.prompt),
                h(
                  'details',
                  null,
                  h(
                    'summary',
                    null,
                    result.structured ? '输出要求 · 结构化参数' : '输出要求 · 随提示词发送',
                  ),
                  h('pre', { style: preStyle }, JSON.stringify(result.schema, null, 2)),
                ),
              ),
      ),
  );
}

export function TemplateEditor({
  template,
  update,
  previewStep,
  disabled,
  providers,
  modelChoices,
}) {
  const [removing, setRemoving] = React.useState(null);
  const btn = (label, action, off = false, props = {}) =>
    button(label, action, disabled || off, props);
  const label = (text, element) =>
    h('label', { style: { display: 'grid', gap: 3 } }, text, element);
  const input = (value, set, props = {}) =>
    h('input', {
      value: value ?? '',
      onChange: (e) => set(e.target.value),
      ...props,
    });
  const option = (value, text) => h('option', { key: value, value }, text);
  const select = (value, set, options) =>
    h('select', { value, onChange: (e) => set(e.target.value) }, options);
  function changeKind(step, kind) {
    const values = {
      kind,
      reviewPolicy: undefined,
      returnTo: undefined,
      maxRepairs: 0,
      verification: undefined,
    };
    if (!isAgentStep({ kind })) {
      Object.assign(values, {
        backend: kind === 'approval' ? 'human' : 'verification',
        currentDiff: undefined,
        provider: undefined,
        model: undefined,
        reasoningEffort: undefined,
      });
      if (kind === 'verify') {
        Object.assign(values, { inputs: [], verification: { argv: [''], timeoutMs: 120000 } });
      }
    } else if (!isAgentStep(step)) {
      values.backend = 'spawn';
    }
    if (step.instructions === defaultInstructions[step.kind])
      values.instructions = defaultInstructions[kind];
    setStep(step.id, values);
  }
  const setStep = (id, patch) =>
    update({
      steps: template.steps.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  function groupMembers(step) {
    return step.parallelGroup
      ? template.steps.filter((s) => s.parallelGroup === step.parallelGroup)
      : [step];
  }
  function joinProblem(index) {
    const prev = template.steps[index - 1],
      step = template.steps[index];
    if (!prev || !isParallelRead(prev) || !isParallelRead(step))
      return '仅相邻且没有审查退回的只读步骤可以并行。';
    const members = [...groupMembers(prev), ...groupMembers(step)];
    const ids = new Set(members.map((s) => s.id));
    if (
      members.some((s) => s.inputs.some((id) => ids.has(id)) || (s.when && ids.has(s.when.source)))
    )
      return '同组步骤不能互相提供输入报告或触发条件。';
    return '';
  }
  function joinPrevious(index) {
    if (joinProblem(index)) return;
    const prev = template.steps[index - 1],
      step = template.steps[index];
    const members = new Set([...groupMembers(prev), ...groupMembers(step)].map((s) => s.id));
    const parallelGroup = prev.parallelGroup ?? step.parallelGroup ?? crypto.randomUUID();
    update({
      steps: template.steps.map((s) => (members.has(s.id) ? { ...s, parallelGroup } : s)),
    });
  }
  function leaveGroup(step) {
    const members = groupMembers(step),
      position = members.indexOf(step);
    const before = new Set(members.slice(0, position).map((s) => s.id));
    const after = members.slice(position + 1);
    const afterGroup = after.length > 1 ? crypto.randomUUID() : undefined;
    update({
      steps: template.steps.map((s) => {
        if (s.parallelGroup !== step.parallelGroup) return s;
        const group = before.has(s.id)
          ? before.size > 1
            ? step.parallelGroup
            : undefined
          : s.id === step.id
            ? undefined
            : afterGroup;
        return { ...s, parallelGroup: group };
      }),
    });
  }
  function moveProblem(i, offset) {
    const a = template.steps[i],
      b = template.steps[i + offset];
    if (!b) return '已到边界';
    if (a.parallelGroup !== b.parallelGroup) return '请先移出并行组，再调整相对位置。';
    const [later, earlier] = offset < 0 ? [a, b] : [b, a];
    return referencesStep(later, earlier.id)
      ? '「' + later.name + '」引用了「' + earlier.name + '」，请先调整引用。'
      : '';
  }
  function move(i, offset) {
    if (moveProblem(i, offset)) return;
    const steps = [...template.steps];
    [steps[i], steps[i + offset]] = [steps[i + offset], steps[i]];
    update({ steps });
  }
  function moveButton(i, offset) {
    const name = (offset < 0 ? '上移' : '下移') + '「' + template.steps[i].name + '」';
    const reason = moveProblem(i, offset);
    return btn(null, () => move(i, offset), !!reason, {
      variant: 'toolbar',
      size: 'sm',
      style: { width: 28, padding: 0 },
      icon: h(offset < 0 ? IconChevronUpOutlineRegular : IconChevronDownOutlineRegular, {
        size: 14,
      }),
      'aria-label': name,
      title: reason ? name + ' · ' + reason : name,
    });
  }
  function insert(index) {
    const steps = [...template.steps];
    steps.splice(index, 0, newStep());
    update({ steps });
  }
  function remove(id) {
    update({
      steps: template.steps
        .filter((n) => n.id !== id)
        .map((n) => ({
          ...n,
          inputs: n.inputs.filter((input) => input !== id),
          ...(n.when?.source === id && { when: undefined }),
          ...(n.parallelGroup &&
            groupMembers(n).filter((s) => s.id !== id).length === 1 && {
              parallelGroup: undefined,
            }),
          ...(n.returnTo === id ? { returnTo: undefined, maxRepairs: 0 } : {}),
        })),
    });
    setRemoving(null);
  }
  return h(
    'fieldset',
    {
      disabled,
      style: { display: 'grid', gap: 10, border: 0, padding: 0 },
    },
    label(
      '流程名称',
      input(template.name, (v) => update({ name: v })),
    ),
    h(
      'label',
      null,
      h('input', {
        type: 'checkbox',
        checked: !!template.includeDiff,
        onChange: (e) => update({ includeDiff: e.target.checked }),
      }),
      ' 每轮启动时冻结 Git diff，交给本轮 Agent',
    ),
    h(
      'details',
      null,
      h('summary', null, '如何设置并行、分支或人工确认'),
      h('p', null, '相邻的只读步骤可以同时运行。在后一个步骤选择「与上一步并行」。'),
      h(
        'p',
        null,
        '在需要按结果执行的步骤中选择「执行条件」，指定前面的开发步骤或没有退回目标的审查步骤，再选择触发结果。',
      ),
      h(
        'p',
        null,
        '要暂停并等待你的决定，把步骤类型设为「人工确认」，填写提示并勾选需要核对的输入报告。',
      ),
    ),
    h(
      Actions,
      null,
      btn('在开头插入步骤', () => insert(0)),
    ),
    template.steps.map((s, i) => {
      const earlier = template.steps.slice(0, i);
      const dependencies = earlier.filter((n) => canShareInput(n, s));
      const conditionSources = dependencies.filter((n) => canUseAsCondition(n, s));
      const conditionSource = s.when && conditionSources.find((n) => n.id === s.when.source);
      const conditionalUsers = template.steps.filter((n) => n.when?.source === s.id);
      const inputChoices = s.kind === 'verify' ? [] : dependencies;
      const group = groupMembers(s);
      const canJoin =
        i > 0 &&
        isParallelRead(s) &&
        isParallelRead(template.steps[i - 1]) &&
        (!s.parallelGroup || s.parallelGroup !== template.steps[i - 1].parallelGroup);
      const patch = (p) => setStep(s.id, p);
      const consumers = template.steps.filter((n) => n.inputs.includes(s.id));
      const reviews = template.steps.filter((n) => n.returnTo === s.id);
      return h(
        Expandable,
        {
          key: s.id,
          style: { padding: 10, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8 },
          summary:
            i +
            1 +
            '. ' +
            [
              s.name,
              s.parallelGroup && '并行',
              conditionSource && '条件执行',
              !isAgentStep(s)
                ? kinds[s.kind]
                : (providers.find((p) => p.name === backendKey(s.backend))?.instance?.name ??
                  agentName(backendKey(s.backend))),
              s.model,
              s.reasoningEffort,
            ]
              .filter(Boolean)
              .join(' · '),
        },
        label(
          '步骤名称',
          input(s.name, (name) => patch({ name })),
        ),
        label(
          '步骤类型',
          select(
            s.kind,
            (kind) => changeKind(s, kind),
            Object.entries(kinds).map(([k, v]) =>
              h(
                'option',
                {
                  key: k,
                  value: k,
                  disabled:
                    (reviews.length > 0 && k !== 'develop') ||
                    (conditionalUsers.length > 0 && k !== s.kind) ||
                    (s.parallelGroup && !['read', 'plan', 'review'].includes(k)),
                },
                v,
              ),
            ),
          ),
        ),
        !!conditionalUsers.length &&
          h(
            'small',
            null,
            '「' +
              conditionalUsers.map((n) => n.name).join('、') +
              '」按此步骤的报告结果执行。调整执行条件后可以更换类型。',
          ),
        !!reviews.length &&
          h(
            'small',
            null,
            '「' +
              reviews.map((r) => r.name).join('、') +
              '」会退回这里。更改开发类型前请调整退回目标。',
          ),
        label(
          s.kind === 'verify' ? '验证目的' : s.kind === 'approval' ? '确认提示' : '执行说明',
          h('textarea', {
            value: s.instructions,
            onChange: (e) => patch({ instructions: e.target.value }),
          }),
        ),
        s.kind === 'review' &&
          h(ReviewPolicyField, {
            value: s.reviewPolicy,
            onChange: (reviewPolicy) => patch({ reviewPolicy }),
          }),
        instructionExamples[s.kind] &&
          h(
            Actions,
            null,
            h(ActionMenu, {
              label: '插入说明示例',
              disabled,
              items: instructionExamples[s.kind].map(([name, text]) => ({
                label: name,
                disabled: s.instructions.includes(text),
                onClick: () =>
                  patch({
                    instructions: [s.instructions.trimEnd(), text].filter(Boolean).join('\n\n'),
                  }),
              })),
            }),
          ),
        s.kind === 'approval' &&
          h('p', null, '运行到此处会暂停。请在流程详情中查看确认提示与所选报告，决定是否继续。'),
        s.kind === 'verify' &&
          h(VerificationFields, {
            value: s.verification,
            change: (verification) => patch({ verification }),
          }),
        isAgentStep(s) &&
          h(
            'label',
            null,
            h('input', {
              type: 'checkbox',
              checked: !!s.currentDiff,
              onChange: (e) => patch({ currentDiff: e.target.checked || undefined }),
            }),
            ' 执行本步骤时读取最新 Git diff',
          ),
        isAgentStep(s) &&
          h(ProviderPicker, {
            value: s.backend,
            providers,
            readOnly: s.kind !== 'develop',
            set: (backend) =>
              patch({
                backend,
                provider: undefined,
                model: undefined,
                reasoningEffort: undefined,
              }),
          }),
        isAgentStep(s) &&
          h(ModelFields, {
            key: s.backend,
            ...s,
            providers,
            patch,
            load: modelChoices,
          }),
        conditionSources.length > 0 &&
          label(
            '执行条件',
            select(
              s.when?.source ?? '',
              (id) => {
                if (!id) {
                  patch({ when: undefined });
                  return;
                }
                const source = conditionSources.find((n) => n.id === id);
                patch({
                  when: {
                    source: id,
                    equals: Object.keys(outcomes[source.kind])[0],
                  },
                });
              },
              [option('', '始终执行'), ...conditionSources.map((n) => option(n.id, n.name))],
            ),
          ),
        conditionSource &&
          label(
            '满足以下结果时执行',
            select(
              s.when.equals,
              (equals) => patch({ when: { ...s.when, equals } }),
              Object.entries(outcomes[conditionSource.kind]).map(([k, name]) => option(k, name)),
            ),
          ),
        group.length > 1 &&
          h(
            'p',
            null,
            '同时运行：' + group.map((n) => n.name).join('、') + '。组内报告按步骤顺序汇总。',
          ),
        (canJoin || s.parallelGroup) &&
          h(
            Actions,
            null,
            canJoin &&
              btn('与上一步并行', () => joinPrevious(i), !!joinProblem(i), {
                title: joinProblem(i),
              }),
            s.parallelGroup && btn('移出并行组', () => leaveGroup(s)),
          ),
        inputChoices.length > 0 &&
          h(
            'fieldset',
            null,
            h('legend', null, '输入报告'),
            inputChoices.map((n) =>
              h(
                'label',
                { key: n.id },
                h('input', {
                  type: 'checkbox',
                  checked: s.inputs.includes(n.id),
                  onChange: (e) =>
                    patch({
                      inputs: e.target.checked
                        ? [...s.inputs, n.id]
                        : s.inputs.filter((id) => id !== n.id),
                    }),
                }),
                n.name,
              ),
            ),
          ),
        s.kind === 'review' &&
          (s.parallelGroup || conditionalUsers.length > 0) &&
          h(
            'small',
            null,
            conditionalUsers.length
              ? '审查通过后继续。若结果为「需要修改」或「证据不足」，仅在设置了对应分支时继续。'
              : '并行组内的审查步骤不能设置退回目标。',
          ),
        canReturnToDeveloper(s.kind) &&
          !s.parallelGroup &&
          !conditionalUsers.length &&
          label(
            s.kind === 'verify' ? '验证失败时退回' : '发现缺陷时退回',
            select(
              s.returnTo ?? '',
              (v) =>
                patch({
                  returnTo: v || undefined,
                  maxRepairs: v ? s.maxRepairs || 1 : 0,
                }),
              [
                option('', s.kind === 'verify' ? '停止并保留验证报告' : '结束并报告缺陷'),
                ...earlier.filter((n) => n.kind === 'develop').map((n) => option(n.id, n.name)),
              ],
            ),
          ),
        s.returnTo &&
          label(
            '该步骤最多退回次数',
            select(
              s.maxRepairs,
              (n) => patch({ maxRepairs: Number(n) }),
              [0, 1, 2].map((n) => option(n, n)),
            ),
          ),
        h(
          Actions,
          null,
          moveButton(i, -1),
          moveButton(i, 1),
          btn(s.parallelGroup ? '在此组后插入步骤' : '在此后插入步骤', () =>
            insert(template.steps.indexOf(group.at(-1)) + 1),
          ),
          btn(
            '删除步骤',
            () =>
              consumers.length || reviews.length || conditionalUsers.length
                ? setRemoving(s.id)
                : remove(s.id),
            template.steps.length === 1,
            {
              title: template.steps.length === 1 ? '工作流至少需要一个步骤' : '',
            },
          ),
        ),
        removing === s.id &&
          h(
            'div',
            { role: 'group', 'aria-label': '确认删除步骤' },
            h('p', null, '删除「' + s.name + '」将同时移除以下引用。'),
            !!consumers.length &&
              h('p', null, '失去输入报告：' + consumers.map((n) => n.name).join('、')),
            !!reviews.length &&
              h('p', null, '取消退回修改：' + reviews.map((n) => n.name).join('、')),
            !!conditionalUsers.length &&
              h(
                'p',
                null,
                '移除执行条件后将始终执行：' + conditionalUsers.map((n) => n.name).join('、'),
              ),
            h(
              Actions,
              null,
              btn('取消', () => setRemoving(null)),
              btn('删除步骤并移除引用', () => remove(s.id)),
            ),
          ),
        isAgentStep(s) && h(StepPreview, { template, step: s, load: previewStep }),
      );
    }),
    h(
      Actions,
      null,
      btn('在末尾添加步骤', () => insert(template.steps.length)),
    ),
  );
}
