import test from 'node:test';
import assert from 'node:assert/strict';
import {
  builtinSequenceSummary,
  sequenceSummary,
  stepGraphIssues,
  canUseAsCondition,
  canShareInput,
  outcomes,
} from '../dist/workflow/rules.js';
import { workflowTemplateSchema } from '../workflow-templates.js';
import { replaceUsages, usages } from '../client/workflow-model.js';
import { resolveRoute } from '../agent-instances.js';

const read = (id, extra = {}) => ({
  id,
  kind: 'read',
  name: id,
  instructions: 'inspect',
  backend: 'spawn',
  inputs: [],
  maxRepairs: 0,
  ...extra,
});

test('displayed instance references, replacement and execution share normalized keys', () => {
  const ref = 'sihq-agent:writer',
    raw = '  ' + ref + '  ';
  const config = {
    developer: raw,
    templates: [null, { steps: [null, read('a', { backend: raw }), read('b', { backend: ref })] }],
  };
  const refs = usages(config, ref);
  assert.equal(refs.length, 3);
  assert.equal(
    resolveRoute({ backend: raw }, [{ id: 'writer', backend: 'spawn' }]).instanceId,
    'writer',
  );
  const updated = { ...config };
  for (const op of replaceUsages(config, refs, 'sihq-agent:next')) updated[op.path[0]] = op.value;
  assert.equal(usages(updated, ref).length, 0);
  assert.equal(usages(updated, 'sihq-agent:next').length, 3);
  assert.equal(usages(config, ref).length, 3);
  assert.deepEqual(updated.templates[1].steps[0], null);
});

test('the editor and schema agree about same-group reports, conditional choices, and issue paths', () => {
  const review = read('audit', { kind: 'review', parallelGroup: 'readers' });
  const sibling = read('inspect', {
    parallelGroup: 'readers',
    inputs: ['audit'],
    when: { source: 'audit', equals: 'passed' },
  });
  const steps = [review, sibling];
  assert.equal(canShareInput(review, sibling), false);
  assert.equal(canUseAsCondition(review, sibling), false);
  assert.equal(canUseAsCondition(review, read('after')), true);
  const result = workflowTemplateSchema.safeParse({ id: 't', name: 't', steps });
  assert.equal(result.success, false);
  const violations = stepGraphIssues(steps);
  assert.deepEqual(
    result.error.issues.map((i) => i.path),
    violations.map((i) => i.path),
  );
  assert.deepEqual(
    violations.map((i) => i.path.at(-1)),
    ['inputs', 'when'],
  );
});

test('a saved or draft preview names both conditional closeout actors with a zero repair budget', () => {
  const preview = builtinSequenceSummary((role) => 'fixture-' + role, 0);
  assert.match(preview, /开发反馈 · fixture-feedback → 最终汇总 · fixture-planner/);
  assert.doesNotMatch(preview, /回到开发/);
  assert.match(
    builtinSequenceSummary((role) => role, 2),
    /最多 2 次/,
  );
});

test('sequence summary includes prior outcome, named group bounds, and the caller-provided actor', () => {
  const steps = [
    read('build', { kind: 'develop' }),
    read('check', { parallelGroup: 'readers', when: { source: 'build', equals: 'incomplete' } }),
    read('second', { parallelGroup: 'readers' }),
  ];
  const summary = sequenceSummary(steps, (s) => s.name + '@spawn');
  assert.equal(
    summary,
    'build@spawn → 并行〔check@spawn（当build：' +
      outcomes.develop.incomplete +
      '） ＋ second@spawn〕',
  );
});
