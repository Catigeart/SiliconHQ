import test from 'node:test';
import assert from 'node:assert/strict';
import { exportWorkflow, inspectImport, prepareImport } from '../workflow-portable.js';
const catalog = [
  { name: 'spawn', read: true, develop: true, modelOverride: true },
  { name: 'read-cli', read: true, develop: false, modelOverride: true },
  { name: 'fixed', read: false, develop: true, modelOverride: false },
  { name: 'claude-code', read: false, develop: true, product: 'claude-code' },
];
const ref = 'sihq-agent:src';
const source = {
  maxRepairs: 2,
  agentInstances: [
    {
      id: 'src',
      name: '诊断',
      backend: 'old',
      provider: 'vendor',
      model: 'M',
      reasoningEffort: 'high',
    },
    { id: 'unused', name: '仅本机', backend: 'private-route' },
  ],
  templates: [
    {
      id: 'one',
      name: '证据',
      steps: [
        {
          id: 'plan',
          name: '计划',
          kind: 'plan',
          instructions: '收集',
          backend: ref,
        },
        {
          id: 'dev',
          name: '开发',
          kind: 'develop',
          instructions: '实现',
          backend: ref,
          inputs: ['plan'],
        },
        {
          id: 'review',
          name: '检查',
          kind: 'review',
          instructions: '核对',
          backend: 'read-cli',
          inputs: ['dev'],
          returnTo: 'dev',
          maxRepairs: 1,
        },
      ],
    },
  ],
  env: { secret: 'DUMMY_NEVER_EXPORT' },
};
const mapping = [
  ['old', 'spawn'],
  ['read-cli', 'read-cli'],
];
const mappedConfig = (config, plan) =>
  Object.assign({}, config, Object.fromEntries(plan.ops.map((o) => [o.path[0], o.value])));
test('custom export includes only referenced instances and legal configuration', () => {
  const file = exportWorkflow(source, 'one');
  assert.deepEqual(
    file.instances.map((i) => i.id),
    ['src'],
  );
  assert.ok(!JSON.stringify(file).includes('DUMMY_NEVER_EXPORT'));
  assert.ok(!JSON.stringify(file).includes('private-route'));
  assert.throws(() => inspectImport({ ...file, env: {} }, catalog));
  assert.throws(() => inspectImport({ ...file, instances: [] }, catalog), /缺少引用/);
  assert.throws(() =>
    inspectImport({ ...file, instances: [{ ...file.instances[0], apiKey: 'secret' }] }, catalog),
  );
  assert.throws(() => inspectImport({ ...file, version: 2 }, catalog), /版本/);
});
test('portable copy remaps routes and preserves IDs within the step graph, originals and default survive', () => {
  const file = exportWorkflow(source, 'one');
  const target = {
    templates: [source.templates[0]],
    agentInstances: [{ id: 'other', name: '诊断', backend: 'fixed' }],
    selectedTemplate: 'one',
    maxRepairs: 0,
  };
  const info = inspectImport(file, catalog);
  assert.deepEqual(info.backends.find((x) => x.source === 'old').targets, ['spawn']);
  const plan = prepareImport(target, file, mapping, catalog);
  const next = mappedConfig(target, plan);
  assert.equal(next.selectedTemplate, 'one');
  assert.equal(next.maxRepairs, 0);
  assert.equal(next.templates[0].id, 'one');
  assert.notEqual(next.templates[1].id, 'one');
  assert.equal(next.templates[1].name, '证据（导入）');
  assert.equal(next.agentInstances[1].name, '诊断（导入）');
  assert.equal(next.agentInstances[1].backend, 'spawn');
  assert.equal(next.agentInstances[1].model, 'M');
  assert.deepEqual(
    next.templates[1].steps.map((s) => s.id),
    ['plan', 'dev', 'review'],
  );
  assert.deepEqual(next.templates[1].steps[1].inputs, ['plan']);
  assert.equal(next.templates[1].steps[2].returnTo, 'dev');
  assert.equal(next.templates[1].steps[1].backend, 'sihq-agent:' + next.agentInstances[1].id);
  assert.deepEqual(target.agentInstances, [{ id: 'other', name: '诊断', backend: 'fixed' }]);
  const equivalent = {
    agentInstances: [{ ...file.instances[0], backend: 'spawn', id: 'local' }],
    templates: [],
  };
  const reused = prepareImport(equivalent, file, mapping, catalog);
  assert.deepEqual(reused.reused, ['诊断']);
  assert.equal(reused.ops.length, 1);
  assert.equal(reused.ops[0].value[0].steps[0].backend, 'sihq-agent:local');
  assert.throws(
    () =>
      prepareImport(
        target,
        file,
        [
          ['old', 'read-cli'],
          ['read-cli', 'read-cli'],
        ],
        catalog,
      ),
    /请选择可用/,
  );
});
test('builtin preserves four role routes, reports changes, and global budget requires explicit selection', () => {
  const file = exportWorkflow(
    { ...source, developer: '  ' + ref + ' ', reviewer: 'read-cli' },
    'siliconhq',
  );
  assert.equal(file.workflow.kind, 'builtin');
  const assignments = [...mapping, ['spawn', 'spawn']];
  const result = prepareImport({}, file, assignments, catalog);
  assert.equal(result.changes.length, 4);
  const next = mappedConfig({}, result);
  assert.equal(next.agentInstances[0].model, 'M');
  assert.equal(next.developer, 'sihq-agent:' + next.agentInstances[0].id);
  assert.equal(next.reviewer, 'read-cli');
  assert.equal(next.feedback, 'spawn');
  assert.ok(
    !result.ops.some((o) => ['maxRepairs', 'templates', 'selectedTemplate'].includes(o.path[0])),
  );
  const dropped = mappedConfig(
    {},
    prepareImport(
      {},
      file,
      [
        ['old', 'fixed'],
        ['read-cli', 'read-cli'],
        ['spawn', 'spawn'],
      ],
      catalog,
      true,
      ['old'],
    ),
  );
  assert.equal(dropped.maxRepairs, 2);
  assert.equal(dropped.agentInstances[0].model, undefined);
  assert.equal(dropped.agentInstances[0].backend, 'fixed');
});
test('branch references, parallel read groups and human approvals survive a move', () => {
  const route = (id, kind, extra = {}) => ({
    id,
    name: id,
    kind,
    backend: 'read-cli',
    instructions: id,
    ...extra,
  });
  const graph = [
    route('review', 'review'),
    route('evidence', 'read', { parallelGroup: 'pair', inputs: ['review'] }),
    route('facts', 'read', {
      parallelGroup: 'pair',
      when: { source: 'review', equals: 'passed' },
    }),
    route('confirm', 'approval', {
      backend: 'human',
      inputs: ['facts', 'evidence'],
    }),
  ];
  const target = { templates: [{ id: 'graph', name: '图', steps: graph }] };
  const file = exportWorkflow(target, 'graph');
  const info = inspectImport(file, catalog);
  assert.deepEqual(
    info.backends.map((x) => x.source),
    ['read-cli'],
  );
  const imported = mappedConfig(
    {},
    prepareImport({}, file, [['read-cli', 'spawn']], catalog),
  ).templates.at(-1);
  assert.equal(imported.steps[1].parallelGroup, 'pair');
  assert.deepEqual(imported.steps[2].when, graph[2].when);
  assert.equal(imported.steps[3].backend, 'human');
  assert.deepEqual(imported.steps[3].inputs, ['facts', 'evidence']);
});

test('repeated import reuses a collision-renamed equivalent; explicit new allocates another', () => {
  const file = exportWorkflow(source, 'one');
  const target = {
    templates: [],
    agentInstances: [{ id: 'local', name: '诊断', backend: 'spawn', model: 'different' }],
  };
  const first = mappedConfig(target, prepareImport(target, file, mapping, catalog));
  const again = prepareImport(first, file, mapping, catalog);
  assert.deepEqual(again.created, []);
  assert.deepEqual(again.reused, ['诊断（导入）']);
  assert.equal(
    again.ops.find((o) => o.path[0] === 'templates').value.at(-1).steps[0].backend,
    'sihq-agent:' + first.agentInstances[1].id,
  );
  const separate = prepareImport(first, file, mapping, catalog, false, [], [['src', 'new']]);
  assert.deepEqual(separate.created, ['诊断（导入 2）']);
});

test('explicit compatible instance replaces its entire source route and the server checks all uses', () => {
  const file = exportWorkflow(source, 'one');
  const target = {
    templates: [],
    agentInstances: [
      { id: 'alt', name: '本机', backend: 'spawn', model: 'different' },
      { id: 'writeOnly', name: '开发', backend: 'fixed' },
    ],
  };
  const picked = [['src', 'sihq-agent:alt']];
  const remaining = [['read-cli', 'read-cli']];
  const info = inspectImport(file, catalog, target, picked);
  assert.deepEqual(
    info.instanceMappings[0].targets.map((t) => t.id),
    ['alt'],
  );
  assert.deepEqual(
    info.backends.map((b) => b.source),
    ['read-cli'],
  );
  const plan = prepareImport(target, file, remaining, catalog, false, [], picked);
  assert.deepEqual(plan.reused, ['本机']);
  assert.deepEqual(plan.created, []);
  assert.deepEqual(
    mappedConfig(target, plan).templates[0].steps.map((s) => s.backend),
    ['sihq-agent:alt', 'sihq-agent:alt', 'read-cli'],
  );
  assert.throws(
    () =>
      prepareImport(target, file, remaining, catalog, false, [], [['src', 'sihq-agent:writeOnly']]),
    /不兼容/,
  );
  assert.throws(
    () =>
      prepareImport({ ...target, agentInstances: [] }, file, remaining, catalog, false, [], picked),
    /已不存在/,
  );
  assert.throws(() => inspectImport(file, catalog, target, [...picked, ...picked]), /重复/);
});

test('unrelated malformed templates survive import and do not prevent exporting a valid template', () => {
  const broken = { id: 'broken', name: 'bad', steps: [] };
  const file = exportWorkflow({ ...source, templates: [broken, ...source.templates] }, 'one');
  const target = { templates: [broken, null] };
  const imported = mappedConfig(target, prepareImport(target, file, mapping, catalog));
  assert.deepEqual(imported.templates.slice(0, 2), [broken, null]);
  assert.equal(imported.templates.at(-1).name, '证据');
});

test('preset imports require the target profile to support the preset and its read/write role', () => {
  const local = [
    {
      name: 'spawn',
      read: true,
      develop: true,
      modelOverride: true,
      agentPreset: true,
      presets: [{ id: 'builder' }, { id: 'sihq-readonly' }, { id: 'stale', broken: 'not loaded' }],
    },
  ];
  const file = exportWorkflow(
    {
      agentInstances: [{ id: 'custom', name: '开发者', backend: 'old', agentPreset: 'builder' }],
      templates: [
        {
          id: 'task',
          name: '开发',
          steps: [
            {
              id: 'build',
              kind: 'develop',
              name: '开发',
              backend: 'sihq-agent:custom',
              instructions: '开发',
            },
          ],
        },
      ],
    },
    'task',
  );
  assert.deepEqual(inspectImport(file, local).backends[0].targets, ['spawn']);
  const mapping = [['old', 'spawn']];
  const plan = prepareImport({}, file, mapping, local);
  assert.equal(mappedConfig({}, plan).agentInstances[0].agentPreset, 'builder');
  for (const preset of ['sihq-readonly', 'stale', 'missing']) {
    const incompatible = { ...file, instances: [{ ...file.instances[0], agentPreset: preset }] };
    assert.deepEqual(inspectImport(incompatible, local).backends[0].targets, []);
    assert.throws(() => prepareImport({}, incompatible, mapping, local), /不兼容|兼容的目标/);
    const dropped = mappedConfig(
      {},
      prepareImport({}, incompatible, mapping, local, false, ['old']),
    );
    assert.equal(dropped.agentInstances[0].agentPreset, undefined);
  }
});

test('an instance pinned to a different product is excluded for settings, replacement and import', async () => {
  const { supportsRoute } = await import('../route-compatibility.js');
  const old = { product: 'codex', backend: 'writer' };
  const target = { name: 'writer', develop: true, product: 'claude-code' };
  assert.equal(supportsRoute(target, old, false), false);
  const source = {
    agentInstances: [{ id: 'p', name: 'old', ...old }],
    templates: [
      {
        id: 'w',
        name: 'w',
        steps: [
          {
            id: 'dev',
            name: 'dev',
            kind: 'develop',
            instructions: 'build',
            backend: 'sihq-agent:p',
          },
        ],
      },
    ],
  };
  const file = exportWorkflow(source, 'w');
  const plan = inspectImport(file, [target]);
  assert.deepEqual(plan.backends[0].targets, []);
  assert.deepEqual(plan.backends[0].clearTargets, ['writer']);
  assert.equal(plan.backends[0].hasOverrides, true);
  assert.deepEqual(plan.backends[0].sourceProducts, ['codex']);
  assert.equal(plan.backends[0].targetProducts.writer, 'claude-code');
  const imported = prepareImport({}, file, [['writer', 'writer']], [target], false, ['writer']);
  const [instance] = imported.ops.find((o) => o.path[0] === 'agentInstances').value;
  assert.equal(instance.product, 'claude-code');
  assert.equal(instance.model, undefined);
  source.agentInstances[0].model = 'codex-specific';
  const override = exportWorkflow(source, 'w');
  const rebound = prepareImport({}, override, [['writer', 'writer']], [target], false, ['writer']);
  assert.deepEqual(inspectImport(override, [target]).backends[0].targets, []);
  assert.equal(rebound.ops.find((op) => op.path[0] === 'agentInstances').value[0].model, undefined);
});
