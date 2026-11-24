import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectInstances, instancesOf, validateInstanceRepair } from '../agent-instances.js';
import { resolveStartPlan } from '../native.js';
import { apply, Config } from '../plugin.js';
import { exportWorkflow, inspectImport, prepareImport } from '../workflow-portable.js';

const good = { id: 'good', name: '分析', backend: 'spawn' };
const duplicate = { id: 'dupe', name: 'D1', backend: 'spawn' };
const malformed = { id: 'legacy', name: '旧格式', backend: 17 };
const rawRows = [null, duplicate, { ...duplicate, id: ' dupe ', name: 'D2' }, good, malformed];
const config = { agentInstances: rawRows };

test('unrelated malformed instance rows survive Cordis and isolate only ambiguous or invalid routes', () => {
  const mounted = Config(config);
  const rows = mounted.agentInstances.get();
  assert.deepEqual(rows, rawRows);
  assert.deepEqual(instancesOf(mounted), [good]);
  const entries = inspectInstances(rows);
  assert.deepEqual(
    entries.filter((e) => e.diagnostic).map((e) => e.index),
    [0, 1, 2, 4],
  );
  assert.match(entries[1].diagnostic, /重复/);
  assert.deepEqual(resolveStartPlan(config, 'session', 'siliconhq').roles.developer, {
    backend: 'spawn',
  });
  assert.throws(
    () => resolveStartPlan({ ...config, developer: 'sihq-agent:dupe' }, 's', 'siliconhq'),
    /dupe/,
  );
});

test('repair validates a single original position without accepting an id collision', () => {
  const [first, second] = rawRows.slice(1, 3);
  assert.throws(() => validateInstanceRepair(rawRows, 2, second), /重复/);
  assert.throws(() => validateInstanceRepair(rawRows, -1, second), /行/);
  assert.throws(
    () => validateInstanceRepair(rawRows, 2, { ...second, id: 'new', name: good.name }),
    /名称/,
  );
  const fixed = validateInstanceRepair(rawRows, 2, { ...second, id: ' fixed ' });
  assert.equal(fixed.id, 'fixed');
  assert.deepEqual(
    inspectInstances(rawRows.with(2, fixed)).flatMap((row) => row.instance ?? []),
    [first, fixed, good],
  );
});

test('catalog and repair RPC address corrupt rows independently of workflows', async () => {
  const routes = new Map();
  const ctx = {
    commands: { register() {} },
    get() {},
    inject(keys, fn) {
      if (keys.includes('connection'))
        fn({
          connection: {
            fetch: {
              register(r) {
                routes.set(r.path, r);
              },
            },
          },
        });
    },
  };
  apply(ctx, config);
  async function call(method, payload) {
    const path = '/api/sihqCatalog/' + method;
    const response = await routes.get(path).fetch(
      new Request('http://localhost' + path, {
        method: 'POST',
        body: JSON.stringify({ rpcId: 'test', payload }),
      }),
    );
    return (await response.json()).result;
  }
  const result = await call('catalog', {});
  assert.equal(result.ok, true);
  assert.equal(result.value.templates[0].id, 'siliconhq');
  assert.deepEqual(
    result.value.instanceEntries.filter((row) => row.diagnostic).map((row) => row.index),
    [0, 1, 2, 4],
  );
  const formSnapshot = await call('catalog', { inspectInstanceRows: [rawRows[4], good] });
  assert.equal(formSnapshot.value.instanceEntries[0].diagnostic.includes('backend'), true);
  assert.equal(formSnapshot.value.instanceEntries[1].instance.id, 'good');
  const fixed = await call('validateInstanceRepair', {
    rows: rawRows,
    index: 1,
    value: { ...duplicate, id: ' repaired ' },
  });
  assert.equal(fixed.value.id, 'repaired');
});

test('import validates every source instance and appends new instances to the untouched target rows', () => {
  const source = {
    agentInstances: [{ ...good, id: 'source', name: '导入' }],
    developer: 'sihq-agent:source',
  };
  const providers = [{ name: 'spawn', read: true, develop: true, modelOverride: true }];
  const file = exportWorkflow(source, 'siliconhq');
  assert.throws(
    () => inspectImport({ ...file, instances: [...file.instances, malformed] }, providers, config),
    /文件中的 Agent 实例第 2 行/,
  );
  assert.throws(
    () =>
      inspectImport(
        { ...file, instances: [file.instances[0], file.instances[0]] },
        providers,
        config,
      ),
    /重复/,
  );
  const target = prepareImport(config, file, [['spawn', 'spawn']], providers);
  const saved = target.ops.find((op) => op.path[0] === 'agentInstances').value;
  assert.deepEqual(saved.slice(0, -1), rawRows);
  assert.equal(saved.at(-1).name, '导入');
});
