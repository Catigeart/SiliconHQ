import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import childProcess from 'node:child_process';
import { Socket } from 'node:net';
import { readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import test from 'node:test';

import { externalBridge, productStart, selectProductSpec } from '../product-adapter.js';

function configuredHost(product, config, apply) {
  const entry = {
    options: { name: '@deepseek-ai/dsh-subagent-' + product, config },
    fiber: { state: 2, resolveConfig: (c) => c },
    moduleNamespace: { apply },
  };
  const registry = { getProvider: (name) => (name === config.providerName ? { name } : undefined) };
  return {
    get(name) {
      if (name === 'loader') return { entries: () => [entry] };
      if (name === 'subagents') return registry;
    },
  };
}

test('matching profile model uses the registered provider while changed configuration preserves the override', () => {
  const config = { providerName: 'writer', model: 'fixed-model', env: {} };
  const ctx = configuredHost('codex', config, () => {});
  const route = {
    backend: externalBridge,
    baseBackend: 'writer',
    model: 'fixed-model',
    product: 'codex',
  };
  const spec = {
    provider: externalBridge,
    agentOptions: { provider: 'writer', model: 'fixed-model' },
  };
  assert.deepEqual(selectProductSpec(ctx, route, spec), { provider: 'writer' });
  config.model = 'replacement';
  assert.equal(selectProductSpec(ctx, route, spec), spec);
  assert.throws(() => selectProductSpec(ctx, { ...route, product: 'claude-code' }, spec), /类型/);
  assert.throws(() => selectProductSpec(ctx, { ...route, baseBackend: 'missing' }, spec), /已停用/);
});

test('fixed Claude profile effort and model also use the registered provider', () => {
  const config = {
    providerName: 'writer',
    env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' },
    model: 'opus',
  };
  const ctx = configuredHost('claude-code', config, undefined);
  const route = {
    backend: externalBridge,
    baseBackend: 'writer',
    model: 'opus',
    reasoningEffort: 'high',
  };
  const spec = {
    provider: externalBridge,
    agentOptions: { provider: 'writer', model: 'opus', reasoningEffort: 'high' },
  };
  assert.deepEqual(selectProductSpec(ctx, route, spec), { provider: 'writer' });
  config.env.CLAUDE_CODE_EFFORT_LEVEL = 'low';
  assert.throws(() => selectProductSpec(ctx, route, spec), /不支持动态覆盖/);
});

// Set this to an installed RC5 profile containing the official product bundles.
// Only package code is loaded. The provider receives a synthetic configuration
// and an in-memory subprocess service, independent of the profile's credentials.
const profile = process.env.SIHQ_TEST_DSH_PROFILE;
const requiresProfile = {
  skip:
    !profile && 'Set SIHQ_TEST_DSH_PROFILE to a DSH RC5 profile for the official adapter contract',
  timeout: 12000,
};
// Fail closed if a future SDK bypasses DSH's injected subprocess service.
function isolateProduct(t) {
  const block = () => {
    throw new Error('External I/O disabled for this provider contract');
  };
  for (const method of [
    'spawn',
    'spawnSync',
    'exec',
    'execSync',
    'execFile',
    'execFileSync',
    'fork',
  ])
    t.mock.method(childProcess, method, block);
  t.mock.method(Socket.prototype, 'connect', block);
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}
async function official(product) {
  const packages = createRequire(join(resolve(profile), 'package.json'));
  const pkg = '@deepseek-ai/dsh-subagent-' + product;
  const { version } = JSON.parse(readFileSync(packages.resolve(pkg + '/package.json'), 'utf8'));
  assert.equal(version, '0.2.2-rc.5', 'select an RC5 profile to verify this pinned contract');
  return (await import(pathToFileURL(packages.resolve(pkg)))).apply;
}
function request(model, reasoningEffort) {
  return {
    cwd: process.cwd(),
    prompt: [{ type: 'text', text: 'contract test' }],
    signal: AbortSignal.timeout(6000),
    agentOptions: { provider: 'writer', model, reasoningEffort },
  };
}
const logger = { warn() {} };

test(
  'official RC5 Codex consumes the overridden model, effort and original permission mode',
  requiresProfile,
  async (t) => {
    isolateProduct(t);
    const apply = await official('codex');
    let spawnSpec, thread;
    const ctx = {
      logger,
      subprocess: {
        spawn(spec) {
          spawnSpec = spec;
          const stdin = new PassThrough(),
            stdout = new PassThrough(),
            done = Promise.withResolvers();
          let pending = '';
          stdin.setEncoding('utf8').on('data', (chunk) => {
            pending += chunk;
            const frames = pending.split('\n');
            pending = frames.pop();
            for (const line of frames.filter(Boolean)) {
              const msg = JSON.parse(line);
              if (msg.method === 'initialize')
                stdout.write(JSON.stringify({ id: msg.id, result: {} }) + '\n');
              if (msg.method === 'thread/start') {
                thread = msg.params;
                stdout.write(
                  JSON.stringify({
                    id: msg.id,
                    error: { code: -32603, message: 'fixture closed' },
                  }) + '\n',
                );
              }
            }
          });
          return {
            stdin,
            stdout,
            done: done.promise,
            terminate: () => done.resolve({ exitCode: 0, signal: null }),
            waitForExit: () => done.promise,
          };
        },
      },
    };
    const entry = {
      product: 'codex',
      apply,
      config: {
        providerName: 'writer',
        model: 'prior',
        env: { SIHQ_MARKER: 'fixture' },
        permissionMode: 'approve-for-me',
        disposeGraceMs: 50,
      },
    };
    await assert.rejects(productStart(entry, request('codex-fixture', 'medium'), ctx));
    assert.equal(thread.model, 'codex-fixture');
    assert.equal(thread.sandbox, 'workspace-write');
    assert.equal(thread.approvalPolicy, 'on-request');
    assert.deepEqual(spawnSpec.argv.slice(-2), ['-c', 'model_reasoning_effort="medium"']);
    assert.equal(spawnSpec.env.SIHQ_MARKER, 'fixture');
  },
);

test(
  'official RC5 Claude SDK constructs the expected managed subprocess',
  requiresProfile,
  async (t) => {
    isolateProduct(t);
    const apply = await official('claude-code');
    let spec;
    const ctx = {
      logger,
      subprocess: {
        spawn(value) {
          spec = value;
          throw new Error('fixture closed before execution');
        },
      },
    };
    const entry = {
      product: 'claude-code',
      apply,
      config: {
        providerName: 'writer',
        model: 'prior',
        env: { SIHQ_MARKER: 'fixture' },
        permissionMode: 'acceptEdits',
        disposeGraceMs: 50,
      },
    };
    await assert.rejects(productStart(entry, request('claude-fixture', 'high'), ctx));
    assert.ok(spec, 'the SDK reached the injected subprocess service');
    assert.equal(spec.argv[spec.argv.indexOf('--model') + 1], 'claude-fixture');
    assert.equal(spec.argv[spec.argv.indexOf('--permission-mode') + 1], 'acceptEdits');
    assert.equal(spec.env.CLAUDE_CODE_EFFORT_LEVEL, 'high');
    assert.equal(spec.env.SIHQ_MARKER, 'fixture');
    assert.equal(entry.config.env.CLAUDE_CODE_EFFORT_LEVEL, undefined);
  },
);
