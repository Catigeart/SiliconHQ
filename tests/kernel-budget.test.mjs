import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBudget, parseLimit } from '../dist/kernel/budget.js';
test('time-only resolves all non-time limits to null and rejects conflicting finite flags', () => {
  assert.deepEqual(resolveBudget({ seconds: 100 }, true), {
    seconds: 100,
    experiments: null,
    calls: null,
    tokens: null,
    stageSeconds: null,
    attempts: null,
  });
  assert.equal(resolveBudget({ seconds: null }, true).seconds, null);
  assert.throws(() => resolveBudget({ calls: 10 }, true), /不接受/);
  assert.equal(parseLimit('unlimited'), null);
  assert.throws(() => parseLimit('Infinity'));
  assert.throws(() => parseLimit('-1'));
  assert.throws(() => resolveBudget({ seconds: 0 }, false));
});

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { recordReferences } from '../dist/kernel/references.js';
test('reference notes verify real file hashes and reject paths outside the knowledge library', () => {
  const root = mkdtempSync(join(tmpdir(), 'kernel-refs-'));
  try {
    const library = join(root, 'library');
    mkdirSync(library);
    const file = join(library, 'inverse.cu');
    writeFileSync(file, 'reference algorithm');
    const hash = createHash('sha256').update('reference algorithm').digest('hex');
    const state = { references: { root: library }, experiment: 1 };
    const plan = {
      algorithmFamily: 'warp',
      references: [
        {
          path: file,
          sha256: hash,
          symbol: 'inverse',
          idea: 'tiles',
          limitations: 'port required',
        },
      ],
    };
    recordReferences(state, root, plan);
    recordReferences(state, root, plan);
    assert.equal(JSON.parse(readFileSync(join(root, 'research-notes.json'))).length, 1);
    plan.references[0].sha256 = '0'.repeat(64);
    assert.throws(() => recordReferences(state, root, plan), /哈希不匹配/);
    plan.references[0].path = join(root, 'research-notes.json');
    assert.throws(() => recordReferences(state, root, plan), /指定 references/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
