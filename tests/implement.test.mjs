import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { RunStore } from '../dist/storage/runs.js';
import { prepareImplementation } from '../dist/execution/prepare.js';
import { captureGit } from '../dist/workspace/git.js';
const plan = {
  goal: 'fixture',
  steps: [{ description: 'add a file', files: ['hello.txt'], validation: 'read it' }],
  acceptanceCriteria: ['file exists'],
  risks: [],
};
test('implementation CLI isolates sessions, snapshots plan, records baseline and resumes', () => {
  const root = mkdtempSync(join(tmpdir(), 'llm-implement-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const store = new RunStore(join(root, '.llm-coder', 'runs'));
    const source = store.create('original requirement', repo);
    source.role = 'planner';
    source.status = 'completed';
    source.threadId = 'planner-thread';
    store.save(source);
    writeFileSync(join(store.directory(source.id), 'plan.json'), JSON.stringify(plan));
    const fake = `#!${process.execPath}
import fs from 'node:fs';
const prompt=fs.readFileSync(0,'utf8');
fs.appendFileSync(process.env.HOME+'/calls.jsonl',JSON.stringify({args:process.argv.slice(2),prompt})+'\\n');
const report={summary:'done',outcome:prompt.includes('FAIL')?'incomplete':'implemented',changes:[],validations:[],remaining:[]};
for(const event of [{type:'thread.started',thread_id:'developer-thread'},{type:'item.completed',item:{type:'agent_message',id:'a',text:JSON.stringify(report)}},{type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}]) console.log(JSON.stringify(event));
`;
    writeFileSync(join(bin, 'codex'), fake, { mode: 0o755 });
    writeFileSync(join(bin, 'package.json'), '{"type":"module"}');
    const invoke = (args) =>
      spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], {
        cwd: root,
        env: {
          ...process.env,
          SIHQ_CODEX_TRANSPORT: 'exec',
          SIHQ_RECOVERY_WINDOW_MS: '0',
          SIHQ_OUTPUT_CORRECTIONS: '0',
          HOME: root,
          PATH: bin + ':' + process.env.PATH,
        },
        encoding: 'utf8',
      });
    let result = invoke(['implement', source.id]);
    assert.equal(result.status, 0, result.stderr);
    const run = store.list().find((r) => r.role === 'developer');
    assert.ok(run);
    assert.equal(run.cwd, repo);
    assert.equal(run.sourcePlanId, source.id);
    assert.equal(run.threadId, 'developer-thread');
    const call = JSON.parse(readFileSync(join(root, 'calls.jsonl'), 'utf8').trim());
    assert.ok(call.args.includes('gpt-6.1-sol'));
    assert.ok(call.args.includes('workspace-write'));
    assert.ok(!call.args.includes('resume'));
    assert.ok(call.prompt.includes('original requirement'));
    writeFileSync(join(store.directory(source.id), 'plan.json'), '{}');
    result = invoke(['resume', run.id, 'FAIL']);
    assert.equal(result.status, 1, result.stderr);
    assert.equal(store.read(run.id).implementationOutcome, 'incomplete');
    assert.equal(
      JSON.parse(readFileSync(join(store.directory(run.id), 'plan-snapshot.json'), 'utf8')).plan
        .goal,
      'fixture',
    );
    assert.throws(() => prepareImplementation(store, source.id));
    source.status = 'failed';
    store.save(source);
    assert.throws(() => prepareImplementation(store, source.id), /成功完成/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('Git baseline records existing tracked and untracked changes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-git-'));
  try {
    spawnSync('git', ['init', dir]);
    writeFileSync(join(dir, 'existing.txt'), 'keep');
    const baseline = captureGit(dir);
    assert.equal(baseline.available, true);
    assert.match(baseline.status, /existing.txt/);
    assert.match(baseline.files.find((f) => f.path === 'existing.txt').sha256, /^[a-f0-9]{64}$/);
    assert.equal(baseline.head, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
