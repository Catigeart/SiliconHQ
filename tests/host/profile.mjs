export const quickName = 'Smoke 快读';
export const flowName = 'Smoke 报告验收';
export const gitName = 'Smoke 需要 Git';
export const badName = 'Smoke 损坏模板';
export const incompleteName = 'Smoke 未完成开发';
export const capacityName = 'Smoke 并发限额';
export const diffFlowName = 'Smoke 变更输入';
export const repairFlowName = 'Smoke 人工返工';
export const reassignFlowName = 'Smoke 改派实例';
export const verifyRepairName = 'Smoke 测试驱动返工';
export const verifyFlowName = 'Smoke 执行验证';
export const readStep = {
  id: 'read',
  name: '阅读证据',
  kind: 'read',
  instructions: 'SMOKE_READ',
  backend: 'sihq-agent:quick',
  inputs: [],
};
export const gate = {
  id: 'gate',
  name: '人工核对',
  kind: 'approval',
  backend: 'human',
  instructions: '已核对报告？',
  inputs: ['read'],
};

export function profilePatch(currentSuite) {
  const templates = [
    {
      id: currentSuite ? '  evidence  ' : 'evidence',
      name: flowName,
      steps: [
        readStep,
        gate,
        { ...readStep, id: 'last', name: '复核证据', instructions: 'SMOKE_DONE', inputs: ['read'] },
      ],
    },
    ...(currentSuite
      ? [{ id: '  padded-delete  ', name: 'Smoke padded delete', steps: [readStep] }]
      : []),
    { id: 'git', name: gitName, includeDiff: true, steps: [readStep] },
    {
      id: 'capacity',
      name: capacityName,
      steps: ['left', 'right'].map((id) => ({
        ...readStep,
        id,
        name: id,
        instructions: 'SMOKE_' + id.toUpperCase(),
        parallelGroup: 'readers',
      })),
    },
    {
      id: 'incomplete',
      name: incompleteName,
      steps: [
        {
          ...readStep,
          id: 'dev',
          name: '实现',
          kind: 'develop',
          instructions: 'SMOKE_INCOMPLETE',
          backend: 'spawn',
          provider: 'sihq-test',
          model: 'quick',
        },
        { ...gate, inputs: ['dev'], when: { source: 'dev', equals: 'implemented' } },
      ],
    },
  ];
  if (currentSuite) {
    templates.push(
      { id: 'broken', name: badName, steps: [{ ...readStep, inputs: ['removed'] }] },
      {
        id: 'offline',
        name: 'Smoke 离线流程',
        steps: [{ ...readStep, backend: 'offline-fixture' }],
      },
      {
        id: 'padded-instance',
        name: 'Smoke 旧实例引用',
        steps: [{ ...readStep, backend: '  sihq-agent:legacy  ' }],
      },
      {
        id: 'diffs',
        name: diffFlowName,
        includeDiff: true,
        steps: [
          { ...readStep, instructions: 'SMOKE_BASE' },
          { ...gate },
          { ...readStep, id: 'frozen', name: '仅读启动快照', instructions: 'SMOKE_FROZEN' },
          {
            ...readStep,
            id: 'live',
            name: '读取步骤变更',
            instructions: 'SMOKE_LIVE',
            currentDiff: true,
          },
        ],
      },
      {
        id: 'gate-return',
        name: repairFlowName,
        steps: [{ ...readStep, instructions: 'SMOKE_REVISION' }, gate],
      },
      {
        id: 'reroute',
        name: reassignFlowName,
        steps: [{ ...readStep, instructions: 'SMOKE_REASSIGN' }],
      },
      {
        id: 'verify-repair',
        name: verifyRepairName,
        steps: [
          {
            id: 'writer',
            name: '修复代码',
            kind: 'develop',
            instructions: 'SMOKE_FIX',
            backend: 'spawn',
            provider: 'sihq-test',
            model: 'quick',
          },
          {
            id: 'unit',
            kind: 'verify',
            backend: 'verification',
            name: '复测',
            instructions: '检查退出码',
            verification: { argv: ['node', 'repair-smoke.cjs'], timeoutMs: 15000 },
          },
        ],
      },
      {
        id: 'verify-local',
        name: verifyFlowName,
        steps: [
          {
            id: 'unit',
            kind: 'verify',
            backend: 'verification',
            name: '运行本地命令',
            instructions: '执行隔离工作区中的验收夹具',
            verification: { argv: ['node', 'verify-smoke.cjs'], timeoutMs: 15000 },
            inputs: [],
          },
        ],
      },
    );
  }
  return [
    { id: 'ui-settings-general', config: { welcomeNoticeVersion: '2026-09-28.1' } },
    {
      id: 'siliconhq-command',
      config: {
        agentInstances: [
          {
            id: 'quick',
            name: quickName,
            backend: 'spawn',
            provider: 'sihq-test',
            model: 'quick',
            reasoningEffort: 'low',
          },
          ...(currentSuite
            ? [
                {
                  id: 'deep',
                  name: 'Smoke 深读',
                  backend: 'spawn',
                  provider: 'sihq-test',
                  model: 'deep',
                  reasoningEffort: 'high',
                },
                ...[1, 2, 3].map((n) => ({
                  id: 'dupe',
                  name: 'Smoke duplicate ' + n,
                  backend: 'spawn',
                })),
                { id: 'legacy', name: 'Smoke 旧实例', backend: 'spawn' },
                {
                  id: 'offline-agent',
                  name: 'Smoke 离线实例',
                  backend: 'offline-fixture',
                  product: 'codex',
                  model: 'offline-model',
                },
              ]
            : []),
        ],
        templates,
      },
    },
  ];
}

export function overlay(fixturePath) {
  return [
    { insert: [{ id: 'sihq-test-adapter', name: fixturePath }] },
    ...['llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'session-title-llm'].map((id) => ({
      id,
      disabled: true,
    })),
    { id: 'agent-default-model', config: { provider: 'sihq-test', model: 'quick' } },
    { id: 'tool-jobs', config: { completionDelivery: 'quiet' } },
    { id: 'subagent', config: { maxActiveSubagents: 1 } },
  ];
}
