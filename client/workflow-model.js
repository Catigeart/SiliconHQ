import {
  agentName,
  backendKey,
  builtinRoles,
  workflowRowId,
  defaultRepairBudget,
  defaultRoleFields,
  defaultWorkflowId,
  roleLabels,
} from '../dist/workflow/rules.js';

export const defaults = {
  ...defaultRoleFields,
  maxRepairs: defaultRepairBudget,
  reviewPolicy: 'strict',
  selectedTemplate: defaultWorkflowId,
  templates: [],
  agentInstances: [],
};

export function exampleCommand(t) {
  if (/["'\r\n]/.test(t.id))
    return '/sihq ' + JSON.stringify(['workflow', '--template', t.id, '你的任务']);
  return '/sihq workflow --template "' + t.id + '" "你的任务"';
}

export const defaultInstructions = {
  read: '读取工作区并报告检查结果。',
  plan: '写出实现计划和可独立验证的验收标准。',
  develop: '按任务要求修改代码并验证结果。',
  review: '独立审查改动，列出问题、证据和审查结论。',
  approval: '请核对前序结果，确认后继续执行。',
  verify: '运行项目验证命令并记录结果。',
};
export const newStep = () => ({
  id: crypto.randomUUID(),
  name: '新步骤',
  kind: 'read',
  instructions: defaultInstructions.read,
  backend: 'spawn',
  inputs: [],
  maxRepairs: 0,
});

export function newTemplate(base, draft, all) {
  let seed, name;
  if (base === 'siliconhq') {
    const stage = (id, name, kind, role, instructions, inputs) => ({
      id,
      name,
      kind,
      backend: draft[role],
      provider: draft[role + 'Llm'] || undefined,
      model: draft[role + 'Model'] || undefined,
      reasoningEffort: draft[role + 'ReasoningEffort'] || undefined,
      instructions,
      inputs,
      maxRepairs: 0,
    });
    name = '开发与审查';
    seed = {
      includeDiff: false,
      steps: [
        stage('plan', '计划', 'plan', 'planner', defaultInstructions.plan, []),
        stage(
          'develop',
          '开发',
          'develop',
          'developer',
          '按计划完成任务；收到审查意见时修改并验证。',
          ['plan'],
        ),
        {
          ...stage(
            'review',
            '独立审查',
            'review',
            'reviewer',
            '读取工作区，逐项核对计划和开发报告。',
            ['plan', 'develop'],
          ),
          reviewPolicy: draft.reviewPolicy,
          returnTo: 'develop',
          maxRepairs: draft.maxRepairs,
        },
      ],
    };
  } else if (base === null) {
    name = '自定义流程';
    seed = { includeDiff: false, steps: [newStep()] };
  } else {
    const original = draft.templates.find((t) => workflowRowId(t) === base);
    if (!original) return;
    name = original.name + ' 副本';
    seed = structuredClone(original);
  }
  let title = name,
    n = 2;
  while (all.some((t) => t.name === title)) title = name + ' ' + n++;
  const id = crypto.randomUUID();
  return { ...seed, id, name: title };
}

export { instanceKey } from '../dist/workflow/rules.js';

export const instanceSummary = (i) =>
  [
    agentName(i.backend),
    i.provider,
    i.model || '默认模型',
    i.reasoningEffort || '默认强度',
    i.agentPreset && '预设 ' + i.agentPreset,
  ]
    .filter(Boolean)
    .join(' · ');

export function usages(config, ref) {
  return [
    ...builtinRoles
      .filter((role) => backendKey(config[role]) === ref)
      .map((role) => ({
        role,
        label: 'SiliconHQ 开发流程 / ' + (roleLabels[role] || '反馈'),
        read: role !== 'developer',
      })),
    ...config.templates.flatMap((t, templateIndex) =>
      (Array.isArray(t?.steps) ? t.steps : []).flatMap((s, stepIndex) =>
        backendKey(s?.backend) === ref
          ? [
              {
                templateIndex,
                stepIndex,
                label:
                  (t.name || '流程 ' + (templateIndex + 1)) +
                  ' / ' +
                  (s.name || '步骤 ' + (stepIndex + 1)),
                read: s.kind !== 'develop',
              },
            ]
          : [],
      ),
    ),
  ];
}

// Use the exact positions displayed by usages(), including rows awaiting repair.
export function replaceUsages(config, references, replacement) {
  const ops = [];
  let templates;
  for (const ref of references) {
    if (ref.role) {
      ops.push({ op: 'set', path: [ref.role], value: replacement });
    } else {
      templates ??= [...config.templates];
      const row = templates[ref.templateIndex];
      if (row === config.templates[ref.templateIndex])
        templates[ref.templateIndex] = { ...row, steps: [...row.steps] };
      templates[ref.templateIndex].steps[ref.stepIndex] = {
        ...row.steps[ref.stepIndex],
        backend: replacement,
      };
    }
  }
  if (templates) ops.push({ op: 'set', path: ['templates'], value: templates });
  return ops;
}
