import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planSchema } from '../dist/roles/planner.js';
test('reject incomplete or empty plans', () => {
  assert.equal(
    planSchema.safeParse({ goal: 'x', steps: [], acceptanceCriteria: [], risks: [] }).success,
    false,
  );
  assert.equal(
    planSchema.safeParse({
      goal: 'x',
      steps: [{ description: 'do', files: [], validation: 'check' }],
      acceptanceCriteria: ['works'],
      risks: [],
    }).success,
    true,
  );
});
