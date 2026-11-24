import assert from 'node:assert/strict';
import test from 'node:test';
import { delegationDepthOptions } from '../delegation-depth.js';

const local = { capabilities: { depthLimit: true } };
const external = { capabilities: { depthLimit: false } };

test('depth-capable providers inherit the live DSH limit and reject exhausted parents before admission', () => {
  let limit = 1;
  const service = { resolveMaxDepth: () => limit };
  assert.deepEqual(delegationDepthOptions(service, local), { maxDepth: 1 });
  const resumed = { session: { header: { delegationDepth: 1 } }, options: { subagentDepth: 0 } };
  assert.throws(() => delegationDepthOptions(service, local, resumed), /达到 2.*上限 1/);
  limit = 3;
  assert.deepEqual(delegationDepthOptions(service, local, resumed), { maxDepth: 3 });
  assert.throws(
    () => delegationDepthOptions(service, local, { options: { subagentDepth: 3 } }),
    /达到 4.*上限 3/,
  );
  limit = 0;
  assert.throws(() => delegationDepthOptions(service, local), /达到 1.*上限 0/);
});

test('provider-managed backends receive no unsupported maxDepth option', () => {
  assert.deepEqual(delegationDepthOptions({ resolveMaxDepth: () => assert.fail() }, external), {});
  assert.deepEqual(delegationDepthOptions({}, local), {});
  assert.deepEqual(delegationDepthOptions({ resolveMaxDepth: () => undefined }, local), {});
});
