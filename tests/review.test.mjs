import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { RunStore } from '../dist/storage/runs.js';
import { prepareReview } from '../dist/execution/prepare.js';
import { validateReview as validateReport } from '../dist/roles/reviewer.js';
const validateReview = (store, run, answer) =>
  validateReport(
    answer,
    JSON.parse(readFileSync(join(store.directory(run.id), 'review-snapshot.json'), 'utf8')),
  );
function fixture(root) {
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const store = new RunStore(join(root, '.llm-coder', 'runs'));
  const source = store.create('Original request', repo);
  source.role = 'developer';
  source.status = 'completed';
  source.threadId = 'developer-thread';
  store.save(source);
  writeFileSync(
    join(store.directory(source.id), 'plan-snapshot.json'),
    JSON.stringify({
      originalRequirement: 'Original request',
      plan: {
        goal: 'goal',
        steps: [{ description: 'step', files: [], validation: 'check' }],
        acceptanceCriteria: ['criterion'],
        risks: [],
      },
    }),
  );
  writeFileSync(
    join(store.directory(source.id), 'implementation.json'),
    JSON.stringify({
      summary: 'unverified claim',
      outcome: 'implemented',
      changes: [],
      validations: [],
      remaining: [],
    }),
  );
  return { store, source };
}
const report = {
  verdict: 'passed',
  summary: 'checked',
  criteria: [{ criterion: 'criterion', result: 'passed', evidence: 'actual code' }],
  findings: [],
  checks: [],
  limitations: [],
};
test('reject missing criteria and contradictory pass; retain snapshot and reject failed source', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-schema-'));
  try {
    const { store, source } = fixture(root);
    const run = prepareReview(store, source.id);
    assert.equal(validateReview(store, run, JSON.stringify(report)).verdict, 'passed');
    assert.throws(
      () =>
        validateReview(
          store,
          run,
          JSON.stringify({ ...report, criteria: [{ ...report.criteria[0], criterion: 'other' }] }),
        ),
      /完整覆盖/,
    );
    assert.throws(
      () =>
        validateReview(
          store,
          run,
          JSON.stringify({
            ...report,
            checks: [{ command: 'test', result: 'not_run', evidence: 'blocked' }],
          }),
        ),
      /矛盾/,
    );
    writeFileSync(join(store.directory(source.id), 'implementation.json'), '{}');
    assert.equal(validateReview(store, run, JSON.stringify(report)).verdict, 'passed');
    source.status = 'failed';
    store.save(source);
    assert.throws(() => prepareReview(store, source.id), /developer/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('review CLI uses terra/read-only/new thread, preserves source and handles resume verdicts', () => {
  const root = mkdtempSync(join(tmpdir(), 'review-cli-'));
  try {
    const { store, source } = fixture(root);
    const before = JSON.stringify(store.read(source.id));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(bin, 'codex'),
      `#!${process.execPath}
import fs from 'node:fs';
const prompt=fs.readFileSync(0,'utf8');
fs.appendFileSync(process.env.HOME+'/calls',JSON.stringify({args:process.argv.slice(2),prompt})+'\\n');
const report=${JSON.stringify(report)};
if(prompt.includes('BLOCK')) { report.verdict='blocked';report.criteria[0].result='not_verified'; }
if(prompt.includes('DEFECT')) { report.verdict='changes_requested';report.criteria[0].result='failed'; }
if(prompt.includes('INVALID')) report.criteria=[];
for(const event of [{type:'thread.started',thread_id:'review-thread'},{type:'item.completed',item:{type:'agent_message',id:'a',text:JSON.stringify(report)}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}]) console.log(JSON.stringify(event));
`,
      { mode: 0o755 },
    );
    const invoke = (args) =>
      spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], {
        cwd: root,
        env: { ...process.env, HOME: root, PATH: bin + ':' + process.env.PATH },
        encoding: 'utf8',
      });
    assert.equal(invoke(['review']).status, 2);
    const result = invoke(['review', source.id]);
    assert.equal(result.status, 0, result.stderr);
    const run = store.list().find((r) => r.role === 'reviewer');
    assert.ok(run);
    assert.equal(run.sourceImplementationId, source.id);
    assert.equal(run.reviewVerdict, 'passed');
    assert.equal(JSON.stringify(store.read(source.id)), before);
    let call = JSON.parse(readFileSync(join(root, 'calls'), 'utf8').trim());
    assert.ok(call.args.includes('gpt-6.1-terra'));
    assert.ok(call.args.includes('read-only'));
    assert.ok(call.args.includes(source.cwd));
    assert.ok(!call.args.includes('resume'));
    assert.match(call.prompt, /Original request/);
    assert.match(call.prompt, /unverified claim/);
    assert.equal(invoke(['resume', run.id, 'BLOCK']).status, 1);
    assert.equal(store.read(run.id).reviewVerdict, 'blocked');
    assert.equal(invoke(['resume', run.id, 'DEFECT']).status, 1);
    assert.equal(store.read(run.id).reviewVerdict, 'changes_requested');
    assert.equal(invoke(['resume', run.id, 'INVALID']).status, 1);
    assert.equal(store.read(run.id).status, 'failed');
    assert.equal(store.read(run.id).reviewVerdict, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
