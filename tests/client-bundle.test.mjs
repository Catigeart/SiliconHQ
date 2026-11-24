import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';

test('the shipped browser script loads host UI modules and registers the chat command and settings', async () => {
  const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
  const hostModules = new Map([
    ['react', { createElement() {} }],
    ['@deepseek-ai/dsh-client-ui-primitives', {}],
    ['react-dom/client', {}],
  ]);
  const requested = new Set();
  let plugin;
  runInNewContext(source, {
    window: {
      __ModuleLoader__: {
        load({ id, factory }) {
          assert.equal(id, 'dsh-sihq');
          plugin = factory((name) => {
            assert.ok(hostModules.has(name), 'Unexpected host UI module: ' + name);
            requested.add(name);
            return hostModules.get(name);
          });
        },
      },
    },
  });
  assert.ok(requested.has('react'));
  assert.ok(requested.has('@deepseek-ai/dsh-client-ui-primitives'));
  const slots = [];
  const commands = [];
  const tabs = [];
  const host = {
    on() {},
    inject(_services, register) {
      return register(this);
    },
    effect: (run) => run(),
    sidebarRightTabs: { register: (definition) => tabs.push(definition) },
    sidebarRight: {},
    configForms: { whileServed: (_ids, register) => register() },
    slots: {
      inject: (_slot, register) => register(),
      register: ({ name }) => slots.push(name),
    },
    commandUi: { decorate: ({ name }) => commands.push(name) },
  };
  plugin.apply(host);
  assert.deepEqual(commands, ['sihq']);
  assert.deepEqual(slots.sort(), [
    'conversation.input.dock',
    'plugins.bundle.config',
    'sidebar.right.pane.tab',
  ]);
  assert.equal(tabs[0].title(), '当前工作流');
  assert.equal(tabs[0].guide[0].id, 'current');
  slots.length = 0;
  plugin.apply({ ...host, inject() {} });
  assert.deepEqual(slots.sort(), ['conversation.input.dock', 'plugins.bundle.config']);
});
