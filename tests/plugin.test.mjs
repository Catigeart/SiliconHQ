import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply, availableProviders, Config, resolveTemplate } from '../plugin.js';

let command;
apply({
  commands: {
    register(value) {
      command = value;
    },
  },
});
const invoke = (rawInput, cwd = process.cwd()) =>
  command.handler({
    rawInput,
    agent: { id: 'fixture-chat', session: { header: { cwd } } },
    signal: new AbortController().signal,
  });

test('registers the command and handles missing workspace', async () => {
  assert.equal(command.name, 'sihq');
  assert.match((await invoke('', '')).text, /workflow/);
  assert.equal((await invoke('list', '')).kind, 'error');
});
test('runs packaged kernel help', async () => {
  const result = await invoke('["kernel","--help"]');
  assert.equal(result.kind, 'success', result.text);
  assert.match(result.text, /direct-trsm/);
});
test('rejects malformed or interactive requests', async () => {
  for (const input of ['workflow "a', 'chat', '["run", 1]'])
    assert.equal((await invoke(input)).kind, 'error');
});

test('Cordis stores explicit conditions and keeps legacy workflow steps unconditional', () => {
  const step = (id, kind, backend = 'spawn') => ({
    id,
    name: id,
    kind,
    backend,
    instructions: id,
  });
  const old = step('old', 'read');
  const when = { source: 'review', equals: 'passed' };
  const flow = {
    id: 'conditional',
    name: 'Conditional',
    steps: [
      old,
      { ...step('read', 'read'), parallelGroup: 'pair' },
      { ...step('review', 'review'), parallelGroup: 'pair' },
      { ...step('gate', 'approval', 'human'), when },
    ],
  };
  const [stored] = Config({ templates: [flow] }).templates.get();
  assert.equal(stored.steps[0].when, undefined);
  assert.equal(stored.steps[0].parallelGroup, undefined);
  assert.deepEqual(
    stored.steps.map((s) => s.parallelGroup),
    [undefined, 'pair', 'pair', undefined],
  );
  assert.deepEqual(stored.steps[3].when, when);
  assert.equal(stored.steps[3].backend, 'human');
});

test('named launch resolves exact names and keeps ID access for ambiguous names', () => {
  const templates = [
    { id: 'a', name: '审查 diff' },
    { id: 'b', name: '审查 diff' },
    { id: 'c', name: 'a' },
  ];
  assert.equal(resolveTemplate(templates, 'a'), 'a');
  assert.equal(resolveTemplate(templates, 'c'), 'c');
  assert.throws(() => resolveTemplate(templates, '审查 diff'), /同名/);
  assert.throws(() => resolveTemplate(templates, 'missing'), /找不到/);
});

test('catalog uses registered capabilities and includes custom ACP names', () => {
  const providers = new Map([
    ['spawn', { capabilities: { agentPreset: true, agentOptions: true } }],
    ['team-acp', { capabilities: {} }],
    ['fork', { capabilities: { agentPreset: true }, inheritsParentContext: true }],
    ['sihq-codex-readonly', { capabilities: {} }],
  ]);
  const result = availableProviders({ providers, getProvider: (key) => providers.get(key) }, {});
  assert.deepEqual(
    result.find((p) => p.name === 'team-acp'),
    {
      name: 'team-acp',
      registered: true,
      agentPreset: false,
      read: false,
      develop: true,
      modelOverride: false,
    },
  );
  assert.equal(result.find((p) => p.name === 'spawn').modelOverride, true);
  assert.equal(result.find((p) => p.name === 'fork').read, false);
  assert.equal(result.find((p) => p.name === 'sihq-codex-readonly').develop, false);
  assert.ok(!result.some((p) => p.name === 'codex'));
});

test('named launch, old template ID, and draft preview use DSH Jobs and preserve the default', async (t) => {
  const cwd = mkdtempSync(join(tmpdir(), 'sihq-launch-git-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init', '--quiet'], { cwd, windowsHide: true });
  const routes = new Map(),
    jobs = [];
  let entry;
  const config = { selectedTemplate: 'siliconhq' };
  const agent = {
    id: 'test-chat',
    session: { header: { cwd } },
  };
  const context = {
    commands: {
      register(command) {
        entry = command;
      },
    },
    inject(names, callback) {
      if (names.includes('connection'))
        callback({
          connection: {
            fetch: {
              register(r) {
                routes.set(r.path, r);
              },
            },
          },
        });
    },
    get(name) {
      if (name === 'agentPresets') return { resolve: async (id) => ({ id }) };
      if (name === 'subagents')
        return { getProvider: () => ({ capabilities: { agentPreset: true } }) };
      if (name === 'agents') return { get: (id) => (id === agent.id ? agent : undefined) };
      if (name === 'jobs')
        return {
          start(job) {
            jobs.push(job);
            return 'test-job';
          },
        };
    },
  };
  apply(context, config);
  const run = (input, parent = agent) =>
    entry.handler({
      rawInput: input,
      agent: parent,
      signal: new AbortController().signal,
    });
  for (const input of [
    'run "只审查当前 diff" "测试 中文"',
    'workflow --template diff-review "旧指令"',
  ]) {
    assert.equal((await run(input)).kind, 'success');
    assert.match(jobs.at(-1).label, /只审查当前 diff/);
  }
  assert.equal((await run('run "不存在" "任务"')).kind, 'error');
  const route = '/api/sihqCatalog/prepareTrial';
  const template = {
    id: 'temp',
    name: '未保存草稿',
    steps: [
      {
        id: 'r',
        name: '分析',
        kind: 'read',
        instructions: '读取',
        backend: 'spawn',
      },
    ],
  };
  const response = await routes.get(route).fetch(
    new Request('http://localhost' + route, {
      method: 'POST',
      body: JSON.stringify({
        rpcId: 'test',
        payload: {
          selected: 'temp',
          sessionId: agent.id,
          draft: { template, maxRepairs: 1 },
        },
      }),
    }),
  );
  const ticket = (await response.json()).result.value;
  assert.ok(ticket);
  assert.equal(
    (await run('try ' + ticket + ' "测试"', { ...agent, id: 'other-chat' })).kind,
    'error',
  );
  assert.equal((await run('try ' + ticket + ' "测试"')).kind, 'success');
  assert.match(jobs.at(-1).label, /未保存草稿/);
  assert.equal((await run('try ' + ticket + ' "再次执行"')).kind, 'error');
  assert.deepEqual(config, { selectedTemplate: 'siliconhq' });
});

test('step previews use runtime instructions and the backend output contract', async () => {
  const { previewStepInput } = await import('../template-runner.js');
  const { activationPrompt, hostSchema } = await import('../native.js');
  for (const [kind, required] of Object.entries({
    read: 'evidence',
    plan: 'acceptanceCriteria',
    develop: 'outcome',
    review: 'verdict',
  })) {
    const { prompt, schema } = previewStepInput({
      step: { kind, instructions: '检查文件' },
      inputs: [{ id: 'p', name: '初步计划', kind: 'plan' }],
      includeDiff: true,
      repair: kind === 'develop',
    });
    assert.ok(prompt.startsWith('检查文件\n'));
    assert.match(prompt, /本轮用户需求/);
    assert.match(prompt, /初步计划/);
    assert.match(prompt, /已暂存的改动/);
    assert.equal(prompt.includes('独立审查退回意见'), kind === 'develop');
    assert.equal(prompt.includes('请独立核查'), kind === 'review');
    assert.ok(hostSchema(schema).required.includes(required));
    assert.equal(activationPrompt(prompt, schema, true), prompt);
    assert.ok(activationPrompt(prompt, schema, false).endsWith(JSON.stringify(schema)));
  }
});

test('product instances pass isolated model and effort to the existing provider and keep its permissions', async () => {
  const { productStart, resolveRoute } = await import('../agent-instances.js');
  for (const product of ['claude-code', 'codex']) {
    const config = {
      providerName: 'dev',
      env: { ROUTER: 'base' },
      model: 'original',
      permissionMode: 'acceptEdits',
    };
    const inputs = [];
    const entry = {
      product,
      config,
      apply(ctx, c) {
        ctx.subagents.registerProvider({
          start(req) {
            assert.equal(req.agentOptions, undefined);
            assert.equal(c.permissionMode, 'acceptEdits');
            ctx.subprocess.spawn({
              argv: ['codex', 'app-server', '--stdio'],
              env: c.env,
            });
            return c.model;
          },
        });
      },
    };
    const ctx = { subprocess: { spawn: (s) => inputs.push(s) } };
    const run = (model, effort) =>
      productStart(
        entry,
        { agentOptions: { provider: 'dev', model, reasoningEffort: effort } },
        ctx,
      );
    assert.deepEqual(await Promise.all([run('fast', 'low'), run('deep', 'high')]), [
      'fast',
      'deep',
    ]);
    assert.deepEqual(config.env, { ROUTER: 'base' });
    assert.equal(config.model, 'original');
    if (product === 'codex') assert.equal(inputs[1].argv.at(-1), 'model_reasoning_effort="high"');
    else
      assert.deepEqual(
        inputs.map((s) => s.env.CLAUDE_CODE_EFFORT_LEVEL),
        ['low', 'high'],
      );
    assert.deepEqual(
      resolveRoute({ backend: 'sihq-agent:a', model: 'obsolete' }, [
        {
          id: 'a',
          name: 'A',
          backend: 'dev',
          product,
          model: 'chosen',
          reasoningEffort: 'high',
        },
      ]),
      {
        instanceId: 'a',
        instanceName: 'A',
        baseBackend: 'dev',
        product,
        backend: 'sihq-product-instance',
        provider: 'dev',
        model: 'chosen',
        reasoningEffort: 'high',
      },
    );
  }
});

test('reserved tasks cannot switch a named workflow to the single-task CLI', async () => {
  const result = await invoke('run "只审查当前 diff" "--fast"');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /同时匹配/);
});

test('profile catalogs can be listed in a chat without a local project', async () => {
  let command;
  apply({
    commands: {
      register(entry) {
        command = entry;
      },
    },
    get() {
      return undefined;
    },
  });
  for (const rawInput of ['workflow templates', 'providers']) {
    const result = await command.handler({
      rawInput,
      agent: { id: 'chat', session: { header: {} } },
      signal: new AbortController().signal,
    });
    assert.equal(result.kind, 'success', result.text);
  }
});
