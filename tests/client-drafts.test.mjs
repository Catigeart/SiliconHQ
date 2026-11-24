import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeDraft, workflowDraft } from '../client/drafts.js';

test('a workflow edit is written on top of the latest profile, preserving other workflows and agent edits', () => {
  const template = { id: 'x', name: 'Old' };
  const base = { templates: [template], agentInstances: [], selectedTemplate: 'x' };
  const changed = { ...template, name: 'New' };
  const mine = { ...base, templates: [changed] };
  const added = { id: 'remote', name: 'Other' };
  const latest = {
    ...base,
    templates: [added, null, template],
    agentInstances: [{ id: 'new-agent' }],
    selectedTemplate: 'remote',
  };
  const merged = workflowDraft({ base, value: mine }, latest, 'x');
  assert.deepEqual(merged.conflicts, []);
  assert.deepEqual(merged.value, { ...latest, templates: [added, null, changed] });
});

test('edits to different steps, including an added step, survive a remote rename', () => {
  const base = {
    name: 'Review',
    steps: [
      { id: 'read', name: 'Read' },
      { id: 'review', name: 'Review' },
    ],
  };
  const mine = structuredClone(base);
  mine.steps[0].name = 'Read evidence';
  mine.steps.push({ id: 'send', name: 'Send' });
  const current = structuredClone(base);
  current.name = 'Check';
  current.steps[1].name = 'Write a report';
  const result = mergeDraft(base, mine, current);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(result.value, {
    name: 'Check',
    steps: [
      { id: 'read', name: 'Read evidence' },
      { id: 'review', name: 'Write a report' },
      { id: 'send', name: 'Send' },
    ],
  });
});

test('an overlapping edit reports both values and resolving it preserves unrelated changes', () => {
  const base = { name: 'workflow', steps: [{ id: '1', name: 'step', instructions: 'Original' }] };
  const mine = { ...base, name: 'local', steps: [{ ...base.steps[0], instructions: 'Mine' }] };
  const current = {
    ...base,
    steps: [{ ...base.steps[0], name: 'renamed', instructions: 'Updated' }],
  };
  const resolved = mergeDraft(base, mine, current, 'current');
  assert.deepEqual(resolved.conflicts, [
    { path: 'steps / 1 / instructions', mine: 'Mine', current: 'Updated' },
  ]);
  assert.equal(resolved.value.name, 'local');
  assert.deepEqual(resolved.value.steps, current.steps);
  assert.equal(mergeDraft(base, mine, current, 'mine').value.steps[0].instructions, 'Mine');
});

test('editing a deleted instance requires an explicit choice', () => {
  const base = { id: 'named', name: 'Original', backend: 'spawn' };
  const mine = { ...base, name: 'New name' };
  const result = mergeDraft(base, mine, undefined);
  assert.equal(result.conflicts.length, 1);
  assert.equal(result.value.name, 'New name');
  assert.equal(mergeDraft(base, mine, undefined, 'current').value, undefined);
});

test('changing the executor conflicts with edits to dependent model or preset options', () => {
  const instance = { name: 'Reader', backend: 'spawn', agentPreset: 'sihq-readonly' };
  const current = { name: 'Reader', backend: 'claude-code' };
  const mine = { ...instance, name: 'Analyzer', model: 'example' };
  assert.equal(mergeDraft(instance, mine, current).conflicts.length, 1);
  assert.deepEqual(mergeDraft(instance, mine, current, 'current').value, {
    name: 'Analyzer',
    backend: 'claude-code',
  });
  const roles = { reviewer: 'spawn', reviewerModel: '' };
  assert.equal(
    mergeDraft(roles, { ...roles, reviewer: 'new' }, { ...roles, reviewerModel: 'large' }).conflicts
      .length,
    1,
  );
});
