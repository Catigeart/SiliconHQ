import test from 'node:test';
import assert from 'node:assert/strict';
import { listPresetOptions, validatePreset } from '../preset-options.js';
import { instancesOf, resolveRoute, routeLabel } from '../agent-instances.js';
import { routeFor } from '../native.js';
import { Config } from '../plugin.js';

const spawn = {
  capabilities: { agentPreset: true, agentOptions: true },
  inheritsParentContext: false,
};
const service = {
  getProvider(name) {
    if (name === 'spawn') return spawn;
    if (name === 'fork') return { ...spawn, inheritsParentContext: true };
    if (name === 'claude-code') return { capabilities: {} };
  },
};
const instance = (agentPreset, backend = 'spawn') =>
  instancesOf({ agentInstances: [{ id: 'reviewer', name: 'Reviewer', backend, agentPreset }] });
const resolve = (preset, backend) =>
  resolveRoute({ backend: 'sihq-agent:reviewer' }, instance(preset, backend));

test('RC5 Cordis config preserves selected presets and legacy instances without a preset', () => {
  const items = [instance('project-engineer')[0], { id: 'old', name: 'Old', backend: 'spawn' }];
  const parsed = instancesOf(Config({ agentInstances: items }));
  assert.equal(parsed[0].agentPreset, 'project-engineer');
  assert.equal(parsed[1].agentPreset, undefined);
});

test('an existing named DSH preset survives resolution and respects the step permission boundary', () => {
  const route = resolve('project-engineer');
  assert.match(routeLabel(route), /project-engineer/);
  assert.deepEqual(routeFor(service, route, false), {
    provider: 'spawn',
    agentPreset: 'project-engineer',
  });
  assert.throws(() => routeFor(service, route, true), /只读/);
  const reader = resolve('sihq-readonly');
  assert.deepEqual(routeFor(service, reader, true), {
    provider: 'spawn',
    agentPreset: 'sihq-readonly',
  });
  assert.throws(() => routeFor(service, reader, false), /开发/);
  for (const backend of ['fork', 'claude-code'])
    assert.throws(() => routeFor(service, resolve('project-engineer', backend), false), /不支持/);
});

test('preset options expose registry diagnostics and active module names only', async () => {
  const registry = {
    async list() {
      return [
        { id: 'project-engineer', description: 'Review', name: 'Engineer' },
        { id: 'bad', broken: 'requires service' },
      ];
    },
    inspectCompositions() {
      return [
        { id: 'project-engineer', modules: [{ moduleName: 'some-tools', baseUrl: 'private' }] },
      ];
    },
    async resolve(id) {
      if (id === 'removed') throw new Error('Unknown preset');
      return (await this.list()).find((row) => row.id === id);
    },
  };
  const ctx = {
    get(name) {
      if (name === 'agentPresets') return registry;
    },
  };
  const [option, bad] = await listPresetOptions(ctx);
  assert.deepEqual(option.plugins, ['some-tools']);
  assert.equal(bad.broken, 'requires service');
  assert.equal(JSON.stringify(option).includes('private'), false);
  await validatePreset(ctx, option.id);
  await assert.rejects(validatePreset(ctx, bad.id), /requires service/);
  await assert.rejects(validatePreset(ctx, 'removed'), /Unknown preset/);
});
