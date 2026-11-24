import { posixCodexTest as test } from './fixtures/posix-codex.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { WorkflowStore } from '../dist/storage/workflows.js';
import { RunStore } from '../dist/storage/runs.js';
import { lockWorkspace } from '../dist/storage/workspace-lock.js';

function fixture(mode, callback) {
  const root = mkdtempSync(join(tmpdir(), 'workflow-test-'));
  try {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeFileSync(join(bin, 'package.json'), '{"type":"module"}');
    writeFileSync(
      join(bin, 'codex'),
      `#!${process.execPath}
import fs from 'node:fs';
const prompt=fs.readFileSync(0,'utf8');const args=process.argv.slice(2);
let role=args.includes('gpt-6-astra')?'plan':args.includes('gpt-6.1-sol')?'implement':'review';
const schemaIndex=args.indexOf('--output-schema');
const schema=schemaIndex>=0?JSON.parse(fs.readFileSync(args[schemaIndex+1],'utf8')):{};
if(schema.properties?.reasonForStopping)role='summary';
else if(schema.properties?.remainingIssues)role='feedback';
const callsFile=process.env.HOME+'/calls';
const calls=fs.existsSync(callsFile)?fs.readFileSync(callsFile,'utf8').trim().split('\\n').map(JSON.parse):[];
fs.appendFileSync(callsFile,JSON.stringify({role,args,prompt})+'\\n');
const mode=process.env.TEST_MODE;
if(mode==='before_thread' && role==='implement') process.exit(1);
console.log(JSON.stringify({type:'thread.started',thread_id:args.includes('resume')?args[args.indexOf('resume')+1]:role==='implement'?'sol-session':role+'-'+calls.length}));
if(((mode==='error' || (mode==='repair_error' && args.includes('resume'))) && role==='implement') || (mode==='review_error' && role==='review') || (mode==='plan_error' && role==='plan') || (mode==='feedback_error' && role==='feedback') || (mode==='summary_error' && role==='summary')) {console.log(JSON.stringify({type:'turn.failed',error:{message:'provider unavailable'}}));process.exit(0);}
let report;
if(role==='plan') report={goal:'goal',steps:[{description:'step',files:['file.mjs'],validation:'check'}],acceptanceCriteria:['criterion'],risks:[]};
if(role==='implement') report={summary:'implemented',outcome:'implemented',changes:[],validations:[],remaining:[]};
if(role==='review') {
 const reviews=calls.filter(c=>c.role==='review').length;
 const verdict=mode==='blocked'?'blocked':['always_fail','feedback_error','summary_error','summary_invalid'].includes(mode)||mode==='repair_error'||(mode==='fix' && reviews===0)?'changes_requested':'passed';
 report={verdict,summary:'reviewed',criteria:[{criterion:'criterion',result:verdict==='passed'?'passed':verdict==='blocked'?'not_verified':'failed',evidence:'observed evidence'}],findings:verdict==='changes_requested'?[{severity:'high',location:'file.mjs:1',problem:'fixture defect',evidence:'fixture evidence',requestedChange:'repair fixture defect'}]:[],checks:[],limitations:[]};
}
if(role==='feedback')report={summary:'developer explanation',completedWork:['partial implementation'],remainingIssues:[{issue:'fixture defect',evidence:'fixture evidence',reason:'fixture root cause',attemptedFixes:['fixture attempted fix'],nextStep:'investigate fixture'}],needsUserInput:['confirm expected behavior']};
if(role==='summary')report={status:mode==='summary_invalid'?'passed':'repair_limit_reached',summary:'用户最终说明',completedWork:['partial implementation'],remainingIssues:[{issue:'fixture defect',evidence:'fixture evidence',impact:'criterion unmet'}],reasonForStopping:'repair budget exhausted',nextSteps:['investigate fixture'],needsUserInput:['confirm expected behavior']};
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',id:'a',text:JSON.stringify(report)}}));
console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));
`,
      { mode: 0o755 },
    );
    const invoke = (args, options = {}) =>
      spawnSync(process.execPath, [resolve('dist/cli.js'), ...args], {
        cwd: options.cwd ?? repo,
        env: {
          ...process.env,
          SIHQ_CODEX_TRANSPORT: 'exec',
          SIHQ_RECOVERY_WINDOW_MS: '0',
          SIHQ_OUTPUT_CORRECTIONS: '0',
          HOME: root,
          PATH: bin + ':' + process.env.PATH,
          TEST_MODE: options.mode ?? mode,
        },
        encoding: 'utf8',
      });
    callback({
      root,
      repo,
      invoke,
      flows: new WorkflowStore(join(root, '.llm-coder', 'workflows')),
      runs: new RunStore(join(root, '.llm-coder', 'runs')),
      calls: () => readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse),
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('serial workflow preserves IDs and succeeds only after review', () =>
  fixture('pass', ({ invoke, flows, runs, calls }) => {
    const result = invoke(['workflow', 'test request']);
    assert.equal(result.status, 0, result.stderr);
    const [flow] = flows.list();
    assert.equal(flow.status, 'passed');
    assert.deepEqual(
      flow.steps.map((s) => s.stage),
      ['plan', 'implement', 'review'],
    );
    assert.deepEqual(
      calls().map((c) => c.role),
      ['plan', 'implement', 'review'],
    );
    for (const step of flow.steps) assert.equal(runs.read(step.runId).workflowId, flow.id);
    assert.equal(runs.read(flow.implementationRunId).sourcePlanId, flow.planRunId);
    assert.equal(
      runs.read(flow.latestReviewRunId).sourceImplementationId,
      flow.implementationRunId,
    );
    assert.equal(JSON.parse(invoke(['workflow', 'status', flow.id]).stdout).status, 'passed');
  }));
test('blocked review terminates the workflow', () =>
  fixture('blocked', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'test request']).status, 1);
    assert.equal(flows.list()[0].status, 'blocked');
    assert.equal(calls().length, 3);
  }));
test('stage failure is saved and later stages do not run', () =>
  fixture('error', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'test request']).status, 1);
    const [flow] = flows.list();
    assert.equal(flow.status, 'failed');
    assert.match(flow.error, /provider unavailable/);
    assert.equal(flow.steps[1].status, 'failed');
    assert.equal(calls().length, 2);
  }));
test('workspace lock prevents competing managed tasks', () =>
  fixture('pass', ({ repo, invoke, flows }) => {
    // 子进程 HOME 使用隔离目录，此处锁也使用相同的 HOME。
    const previous = process.env.HOME;
    try {
      process.env.HOME = resolve(repo, '..');
      const unlock = lockWorkspace(repo);
      try {
        const result = invoke(['workflow', 'test request']);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /工作目录已有任务/);
        assert.equal(flows.list().length, 0);
      } finally {
        unlock();
      }
    } finally {
      if (previous === undefined) delete process.env.HOME;
      else process.env.HOME = previous;
    }
  }));

test('changes requested resumes sol with evidence and creates a fresh terra review', () =>
  fixture('fix', ({ invoke, flows, runs, calls, root }) => {
    const result = invoke(['workflow', 'repair request']);
    assert.equal(result.status, 0, result.stderr);
    const [flow] = flows.list();
    assert.equal(flow.status, 'passed');
    assert.equal(flow.repairCount, 1);
    assert.deepEqual(
      flow.steps.map((s) => s.stage),
      ['plan', 'implement', 'review', 'repair', 'review'],
    );
    assert.equal(flow.steps[3].runId, flow.implementationRunId);
    assert.equal(flow.steps[3].sourceReviewId, flow.steps[2].runId);
    const all = calls();
    assert.ok(all[3].args.includes('resume'));
    assert.ok(all[3].args.includes('sol-session'));
    assert.match(all[3].prompt, /fixture evidence/);
    assert.match(all[3].prompt, /repair fixture defect/);
    assert.ok(!all[4].args.includes('resume'));
    assert.notEqual(flow.steps[2].runId, flow.steps[4].runId);
    const feedback = JSON.parse(
      readFileSync(
        join(root, '.llm-coder', 'workflows', flow.id, 'repair-1-feedback.json'),
        'utf8',
      ),
    );
    assert.equal(feedback.reviewRunId, flow.steps[2].runId);
    assert.equal(runs.read(flow.implementationRunId).status, 'completed');
  }));
test('persistent defects stop after exactly two repairs', () =>
  fixture('always_fail', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'persistent defect']).status, 1);
    const [flow] = flows.list();
    assert.equal(flow.status, 'repair_limit_reached');
    assert.equal(flow.repairCount, 2);
    assert.equal(flow.steps.length, 9);
    assert.equal(calls().filter((c) => c.role === 'implement').length, 3);
    assert.equal(calls().filter((c) => c.role === 'review').length, 3);
  }));
test('zero repair budget skips repairs but still produces a final explanation', () =>
  fixture('always_fail', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'serial request', '--max-repairs', '0']).status, 1);
    const [flow] = flows.list();
    assert.equal(flow.status, 'repair_limit_reached');
    assert.equal(flow.repairCount, 0);
    assert.equal(calls().length, 5);
    assert.equal(invoke(['workflow', 'invalid budget', '--max-repairs', '-1']).status, 2);
  }));

test('repair execution errors stop without starting another review', () =>
  fixture('repair_error', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'repair failure']).status, 1);
    const [flow] = flows.list();
    assert.equal(flow.status, 'failed');
    assert.equal(flow.stage, 'repair');
    assert.equal(flow.steps.at(-1).status, 'failed');
    assert.equal(calls().length, 4);
  }));

test('resume failed developer in original session and directory without rerunning planner', () =>
  fixture('error', ({ invoke, flows, runs, calls, root, repo }) => {
    assert.equal(invoke(['workflow', 'recover request']).status, 1);
    const [before] = flows.list();
    const planId = before.planRunId,
      implId = before.implementationRunId;
    const result = invoke(['workflow', 'resume', before.id], { mode: 'pass', cwd: root });
    assert.equal(result.status, 0, result.stderr);
    const after = flows.read(before.id);
    assert.equal(after.status, 'passed');
    assert.equal(after.planRunId, planId);
    assert.equal(after.implementationRunId, implId);
    assert.equal(after.repairCount, 0);
    assert.deepEqual(
      calls().map((c) => c.role),
      ['plan', 'implement', 'implement', 'review'],
    );
    assert.ok(calls()[2].args.includes('resume'));
    assert.ok(calls()[2].args.includes('sol-session'));
    assert.ok(calls()[2].args.includes(repo));
    assert.match(calls()[2].prompt, /检查当前工作区/);
    assert.equal(runs.read(implId).executionId, after.steps[1].executionId);
  }));
test('resume restarts stage without session ID, keeping the same run', () =>
  fixture('before_thread', ({ invoke, flows, runs, calls }) => {
    assert.equal(invoke(['workflow', 'restart request']).status, 1);
    const [before] = flows.list();
    assert.equal(runs.read(before.implementationRunId).threadId, undefined);
    const result = invoke(['workflow', 'resume', before.id], { mode: 'pass' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(flows.read(before.id).implementationRunId, before.implementationRunId);
    assert.ok(!calls()[2].args.includes('resume'));
  }));
test('resume reconciles completed stage saved before workflow checkpoint', () =>
  fixture('pass', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'checkpoint request']).status, 0);
    const [flow] = flows.list();
    flow.status = 'running';
    flow.steps.at(-1).status = 'running';
    delete flow.steps.at(-1).finishedAt;
    flows.save(flow);
    const count = calls().length;
    const result = invoke(['workflow', 'resume', flow.id]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls().length, count);
    assert.equal(flows.read(flow.id).steps.at(-1).status, 'completed');
  }));
test('resume interrupted repair keeps its budget and complete feedback', () =>
  fixture('repair_error', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'repair resume', '--max-repairs', '1']).status, 1);
    const [before] = flows.list();
    assert.equal(before.repairCount, 1);
    const result = invoke(['workflow', 'resume', before.id], { mode: 'pass' });
    assert.equal(result.status, 0, result.stderr);
    const after = flows.read(before.id);
    assert.equal(after.status, 'passed');
    assert.equal(after.repairCount, 1);
    assert.equal(after.maxRepairs, 1);
    assert.equal(after.steps.filter((s) => s.stage === 'repair').length, 1);
    assert.match(calls()[4].prompt, /fixture evidence/);
    assert.ok(calls()[4].args.includes('sol-session'));
  }));
test('pending repair does not reuse previous implementation success', () =>
  fixture('fix', ({ invoke, flows, runs, calls }) => {
    assert.equal(invoke(['workflow', 'pending repair']).status, 0);
    const [flow] = flows.list();
    flow.steps = flow.steps.slice(0, 4);
    flow.stage = 'repair';
    flow.status = 'running';
    flow.repairCount = 1;
    const repair = flow.steps.at(-1);
    repair.status = 'running';
    repair.executionId = 'pending-not-started';
    delete repair.finishedAt;
    flows.save(flow);
    const previous = calls().length;
    const result = invoke(['workflow', 'resume', flow.id], { mode: 'pass' });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(calls().length, previous + 2);
    assert.equal(calls()[previous].role, 'implement');
    assert.equal(flows.read(flow.id).repairCount, 1);
  }));
test('resume blocked review rechecks it and never resets exhausted budget', () =>
  fixture('blocked', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'blocked request']).status, 1);
    const [flow] = flows.list();
    const reviewId = flow.latestReviewRunId;
    assert.equal(invoke(['workflow', 'resume', flow.id], { mode: 'pass' }).status, 0);
    assert.equal(flows.read(flow.id).latestReviewRunId, reviewId);
    assert.equal(calls().length, 4);
    assert.ok(calls()[3].args.includes('resume'));
  }));
test('resume exhausted workflow neither calls agents nor grants more repairs', () =>
  fixture('always_fail', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'exhausted request', '--max-repairs', '1']).status, 1);
    const [flow] = flows.list();
    const count = calls().length;
    assert.equal(invoke(['workflow', 'resume', flow.id]).status, 1);
    assert.equal(calls().length, count);
    assert.equal(flows.read(flow.id).repairCount, 1);
  }));
test('resume restores an invalid artifact from the durable result without another agent call', () =>
  fixture('pass', ({ invoke, flows, runs, calls }) => {
    assert.equal(invoke(['workflow', 'invalid artifact']).status, 0);
    const [flow] = flows.list();
    writeFileSync(join(runs.directory(flow.latestReviewRunId), 'review.json'), '{}');
    const count = calls().length;
    assert.equal(invoke(['workflow', 'resume', flow.id]).status, 0);
    assert.equal(calls().length, count);
    assert.equal(
      JSON.parse(readFileSync(join(runs.directory(flow.latestReviewRunId), 'review.json'))).verdict,
      'passed',
    );
  }));
test('active workflow lock rejects resume without altering records', () =>
  fixture('pass', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'locked request']).status, 0);
    const [flow] = flows.list();
    const before = readFileSync(join(flows.directory(flow.id), 'workflow.json'), 'utf8');
    const release = flows.lock(flow.id);
    try {
      assert.equal(invoke(['workflow', 'resume', flow.id]).status, 1);
      assert.equal(readFileSync(join(flows.directory(flow.id), 'workflow.json'), 'utf8'), before);
      assert.equal(calls().length, 3);
    } finally {
      release();
    }
  }));

test('resume interrupted planner keeps the original requirement and proceeds through remaining stages', () =>
  fixture('plan_error', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'original planning requirement']).status, 1);
    const [flow] = flows.list();
    const result = invoke(['workflow', 'resume', flow.id], { mode: 'pass' });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      calls().map((c) => c.role),
      ['plan', 'plan', 'implement', 'review'],
    );
    assert.ok(calls()[1].args.includes('resume'));
    assert.match(calls()[1].prompt, /original planning requirement/);
  }));
test('resume interrupted reviewer uses original session and does not repeat implementation', () =>
  fixture('review_error', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'review interruption']).status, 1);
    const [flow] = flows.list();
    assert.equal(invoke(['workflow', 'resume', flow.id], { mode: 'pass' }).status, 0);
    assert.deepEqual(
      calls().map((c) => c.role),
      ['plan', 'implement', 'review', 'review'],
    );
    assert.ok(calls()[3].args.includes('resume'));
    assert.equal(flows.read(flow.id).latestReviewRunId, flow.latestReviewRunId);
  }));

test('role reasoning levels reach SDK and are recorded independently', () =>
  fixture('pass', ({ invoke, flows, runs, calls, repo }) => {
    const roles = {
      planner: { model: 'gpt-6-astra', reasoningEffort: 'high' },
      developer: { model: 'gpt-6.1-sol', reasoningEffort: 'low' },
      reviewer: { model: 'gpt-6.1-terra', reasoningEffort: 'xhigh' },
    };
    writeFileSync(join(repo, 'sihq.config.json'), JSON.stringify({ roles }));
    const result = invoke(['workflow', 'configured roles']);
    assert.equal(result.status, 0, result.stderr);
    const [flow] = flows.list();
    for (const [index, role] of ['planner', 'developer', 'reviewer'].entries()) {
      const run = runs.read(flow.steps[index].runId);
      assert.equal(run.model, roles[role].model);
      assert.equal(run.reasoningEffort, roles[role].reasoningEffort);
      assert.ok(
        calls()[index].args.includes(`model_reasoning_effort="${roles[role].reasoningEffort}"`),
      );
    }
  }));
test('resume keeps saved model and effort even after local config changes', () =>
  fixture('error', ({ invoke, flows, runs, calls, repo }) => {
    const roles = {
      planner: { model: 'gpt-6-astra', reasoningEffort: 'medium' },
      developer: { model: 'gpt-6.1-sol', reasoningEffort: 'high' },
      reviewer: { model: 'gpt-6.1-terra', reasoningEffort: 'low' },
    };
    const file = join(repo, 'sihq.config.json');
    writeFileSync(file, JSON.stringify({ roles }));
    assert.equal(invoke(['workflow', 'frozen config']).status, 1);
    const [flow] = flows.list();
    roles.developer = { model: 'different-model', reasoningEffort: 'low' };
    writeFileSync(file, JSON.stringify({ roles }));
    assert.equal(invoke(['workflow', 'resume', flow.id], { mode: 'pass' }).status, 0);
    const resumed = calls()[2];
    assert.ok(resumed.args.includes('gpt-6.1-sol'));
    assert.ok(resumed.args.includes('model_reasoning_effort="high"'));
    assert.equal(runs.read(flow.implementationRunId).reasoningEffort, 'high');
  }));
test('legacy runs without effort retain inherited Codex behavior', () =>
  fixture('error', ({ invoke, flows, runs, calls }) => {
    assert.equal(invoke(['workflow', 'legacy effort']).status, 1);
    const [flow] = flows.list();
    const run = runs.read(flow.implementationRunId);
    delete run.reasoningEffort;
    runs.save(run);
    assert.equal(invoke(['workflow', 'resume', flow.id], { mode: 'pass' }).status, 0);
    assert.ok(!calls()[2].args.some((arg) => arg.startsWith('model_reasoning_effort=')));
    assert.equal(runs.read(flow.implementationRunId).reasoningEffort, undefined);
  }));

test('exhausted review flows through developer to planner and a human-readable final report', () =>
  fixture('always_fail', ({ invoke, flows, runs, calls, root }) => {
    const result = invoke(['workflow', 'explain failure', '--max-repairs', '0']);
    assert.equal(result.status, 1, result.stderr);
    const [flow] = flows.list();
    assert.equal(flow.status, 'repair_limit_reached');
    assert.equal(flow.repairCount, 0);
    assert.deepEqual(
      flow.steps.map((s) => s.stage),
      ['plan', 'implement', 'review', 'developer_feedback', 'planner_summary'],
    );
    assert.deepEqual(
      calls().map((c) => c.role),
      ['plan', 'implement', 'review', 'feedback', 'summary'],
    );
    const developer = runs.read(flow.implementationRunId),
      planner = runs.read(flow.planRunId);
    const feedback = runs.read(flow.developerFeedbackRunId),
      summary = runs.read(flow.finalSummaryRunId);
    assert.equal(feedback.sourceRunId, developer.id);
    assert.equal(summary.sourceRunId, planner.id);
    assert.equal(feedback.threadId, developer.threadId);
    assert.equal(summary.threadId, planner.threadId);
    for (const call of calls().slice(3)) {
      assert.ok(call.args.includes('resume'));
      assert.ok(call.args.includes('read-only'));
      assert.ok(!call.args.includes('workspace-write'));
    }
    assert.match(calls()[3].prompt, /fixture evidence/);
    assert.match(calls()[4].prompt, /fixture root cause/);
    assert.match(calls()[4].prompt, /fixture evidence/);
    assert.equal(runs.read(developer.id).purpose, undefined);
    assert.equal(runs.read(planner.id).purpose, undefined);
    assert.match(result.stdout, /任务未通过验收/);
    assert.match(result.stdout, /用户最终说明/);
    assert.match(result.stdout, /需要你提供的信息/);
    const dir = flows.directory(flow.id);
    assert.equal(flow.summaryFile, 'summary.txt');
    assert.equal(
      JSON.parse(readFileSync(join(dir, 'summary.json'), 'utf8')).status,
      'repair_limit_reached',
    );
    assert.match(readFileSync(join(dir, 'summary.txt'), 'utf8'), /fixture evidence/);
    const count = calls().length;
    const resumed = invoke(['workflow', 'resume', flow.id]);
    assert.equal(resumed.status, 1);
    assert.equal(calls().length, count);
    assert.match(resumed.stdout, /用户最终说明/);
  }));
test('developer closeout failure can resume without new repairs or reviews', () =>
  fixture('feedback_error', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'feedback interruption', '--max-repairs', '0']).status, 1);
    const [flow] = flows.list();
    assert.equal(flow.status, 'failed');
    assert.equal(flow.stage, 'developer_feedback');
    assert.equal(flow.stopReason, 'closeout_failed');
    assert.equal(flow.failureReason, 'repair_budget_exhausted');
    const result = invoke(['workflow', 'resume', flow.id], { mode: 'pass' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(flows.read(flow.id).status, 'repair_limit_reached');
    assert.equal(flows.read(flow.id).repairCount, 0);
    assert.deepEqual(
      calls().map((c) => c.role),
      ['plan', 'implement', 'review', 'feedback', 'feedback', 'summary'],
    );
  }));
test('planner closeout failure resumes only planner and keeps frozen model settings', () =>
  fixture('summary_error', ({ invoke, flows, runs, calls, repo }) => {
    assert.equal(invoke(['workflow', 'summary interruption', '--max-repairs', '0']).status, 1);
    const [flow] = flows.list();
    assert.equal(flow.stage, 'planner_summary');
    assert.equal(flow.stopReason, 'closeout_failed');
    writeFileSync(
      join(repo, 'sihq.config.json'),
      JSON.stringify({
        roles: {
          planner: { model: 'changed', reasoningEffort: 'low' },
          developer: { model: 'changed' },
          reviewer: { model: 'changed' },
        },
      }),
    );
    const result = invoke(['workflow', 'resume', flow.id], { mode: 'pass' });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(flows.read(flow.id).status, 'repair_limit_reached');
    assert.deepEqual(
      calls().map((c) => c.role),
      ['plan', 'implement', 'review', 'feedback', 'summary', 'summary'],
    );
    assert.ok(calls().at(-1).args.includes('gpt-6-astra'));
    assert.ok(calls().at(-1).args.includes('model_reasoning_effort="medium"'));
    assert.equal(runs.read(flow.finalSummaryRunId).status, 'completed');
  }));
test('summary cannot reclassify a failed review as passed', () =>
  fixture('summary_invalid', ({ invoke, flows }) => {
    const result = invoke(['workflow', 'invalid summary', '--max-repairs', '0']);
    assert.equal(result.status, 1);
    const [flow] = flows.list();
    assert.equal(flow.status, 'failed');
    assert.equal(flow.stopReason, 'closeout_failed');
    assert.equal(flow.summaryFile, undefined);
  }));
test('legacy exhausted flow runs closeout on resume without granting repair budget', () =>
  fixture('always_fail', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'legacy exhausted', '--max-repairs', '0']).status, 1);
    const [flow] = flows.list();
    flow.steps = flow.steps.slice(0, 3);
    flow.stage = 'review';
    delete flow.finalSummaryRunId;
    delete flow.developerFeedbackRunId;
    delete flow.summaryFile;
    flows.save(flow);
    const count = calls().length;
    assert.equal(invoke(['workflow', 'resume', flow.id]).status, 1);
    assert.equal(calls().length, count + 2);
    assert.equal(flows.read(flow.id).repairCount, 0);
  }));

test('continue retains workflow and role sessions but creates isolated round reports', () =>
  fixture('pass', ({ invoke, flows, runs, calls }) => {
    assert.equal(invoke(['workflow', 'first requirement']).status, 0);
    const first = flows.list()[0];
    const plan = readFileSync(join(runs.directory(first.planRunId), 'plan.json'), 'utf8');
    const result = invoke(['workflow', 'continue', first.id, 'second requirement']);
    assert.equal(result.status, 0, result.stderr);
    const second = flows.read(first.id);
    assert.equal(second.round, 2);
    assert.equal(second.rounds.length, 1);
    assert.equal(second.rounds[0].prompt, 'first requirement');
    assert.equal(second.prompt, 'second requirement');
    assert.equal(second.rounds[0].status, 'passed');
    assert.equal(second.repairCount, 0);
    assert.equal(second.status, 'passed');
    for (const field of ['planRunId', 'implementationRunId', 'latestReviewRunId']) {
      assert.notEqual(second[field], first[field]);
      assert.equal(runs.read(second[field]).threadId, runs.read(first[field]).threadId);
      assert.equal(runs.read(second[field]).model, runs.read(first[field]).model);
    }
    assert.equal(readFileSync(join(runs.directory(first.planRunId), 'plan.json'), 'utf8'), plan);
    assert.ok(
      calls()
        .slice(3)
        .every((c) => c.args.includes('resume')),
    );
    assert.match(calls()[3].prompt, /second requirement/);
    assert.equal(invoke(['workflow', 'continue', first.id, 'third requirement']).status, 0);
    assert.equal(flows.read(first.id).rounds.length, 2);
    assert.equal(flows.read(first.id).round, 3);
  }));

test('continued round failure resumes current round without changing archived round', () =>
  fixture('pass', ({ invoke, flows, calls }) => {
    invoke(['workflow', 'first']);
    const first = flows.list()[0];
    assert.equal(invoke(['workflow', 'continue', first.id, 'second'], { mode: 'error' }).status, 1);
    const failed = flows.read(first.id);
    assert.equal(failed.round, 2);
    assert.equal(failed.status, 'failed');
    const count = calls().length;
    assert.equal(invoke(['workflow', 'continue', first.id, 'must not replace']).status, 1);
    assert.equal(calls().length, count);
    assert.equal(flows.read(first.id).prompt, 'second');
    assert.equal(invoke(['workflow', 'resume', first.id]).status, 0);
    const done = flows.read(first.id);
    assert.equal(done.round, 2);
    assert.equal(done.rounds.length, 1);
    assert.equal(done.rounds[0].planRunId, first.planRunId);
    assert.deepEqual(
      calls()
        .slice(count)
        .map((c) => c.role),
      ['implement', 'review'],
    );
  }));

test('continued exhausted rounds reset repair budget and preserve summaries and feedback', () =>
  fixture('always_fail', ({ invoke, flows, runs, root }) => {
    invoke(['workflow', 'first', '--max-repairs', '1']);
    const first = flows.list()[0];
    const dir = flows.directory(first.id);
    const summary = readFileSync(join(dir, 'summary.json'), 'utf8');
    const feedback = readFileSync(join(dir, 'repair-1-feedback.json'), 'utf8');
    assert.equal(invoke(['workflow', 'continue', first.id, 'second']).status, 1);
    const second = flows.read(first.id);
    assert.equal(second.status, 'repair_limit_reached');
    assert.equal(second.repairCount, 1);
    assert.equal(second.rounds[0].repairCount, 1);
    assert.equal(second.summaryFile, 'round-2/summary.txt');
    assert.equal(readFileSync(join(dir, 'summary.json'), 'utf8'), summary);
    assert.equal(readFileSync(join(dir, 'repair-1-feedback.json'), 'utf8'), feedback);
    assert.ok(readFileSync(join(dir, 'round-2', 'summary.txt'), 'utf8'));
    assert.ok(readFileSync(join(dir, 'round-2', 'repair-1-feedback.json'), 'utf8'));
    assert.equal(runs.read(second.planRunId).sourceRunId, first.finalSummaryRunId);
    assert.equal(runs.read(second.implementationRunId).sourceRunId, first.developerFeedbackRunId);
  }));

function requestedTier(call) {
  return call.args.find((value) => value.startsWith('service_tier='));
}
test('workflow speed flags reach all stages including repairs and closeout and persist', () =>
  fixture('always_fail', ({ invoke, flows, runs, calls }) => {
    const result = invoke(['workflow', 'speed test', '--fast', '--max-repairs', '1']);
    assert.equal(result.status, 1, result.stderr);
    const flow = flows.list()[0];
    assert.equal(flow.speedOverride, 'fast');
    assert.ok(calls().length >= 7);
    for (const call of calls()) {
      assert.equal(requestedTier(call), 'service_tier="fast"');
      assert.ok(call.args.includes('features.fast_mode=true'));
    }
    for (const step of flow.steps) assert.equal(runs.read(step.runId).speed, 'fast');
    const n = calls().length;
    assert.equal(
      invoke(['workflow', 'continue', flow.id, 'next', '--no-fast'], { mode: 'pass' }).status,
      0,
    );
    const next = flows.read(flow.id);
    assert.equal(next.speedOverride, 'standard');
    assert.equal(next.rounds[0].speedOverride, 'fast');
    for (const call of calls().slice(n)) {
      assert.equal(requestedTier(call), 'service_tier="default"');
      assert.ok(call.args.includes('features.fast_mode=false'));
    }
  }));
test('role speed applies independently and inherit adds no service tier override', () =>
  fixture('pass', ({ repo, invoke, flows, runs, calls }) => {
    writeFileSync(
      join(repo, 'sihq.config.json'),
      JSON.stringify({
        roles: {
          planner: { model: 'gpt-6-astra', speed: 'fast' },
          developer: { model: 'gpt-6.1-sol', speed: 'standard' },
          reviewer: { model: 'gpt-6.1-terra' },
        },
      }),
    );
    assert.equal(invoke(['workflow', 'test']).status, 0);
    assert.deepEqual(calls().map(requestedTier), [
      'service_tier="fast"',
      'service_tier="default"',
      undefined,
    ]);
    const flow = flows.list()[0];
    assert.equal(runs.read(flow.latestReviewRunId).speed, 'inherit');
  }));
test('resume keeps speed unless explicitly overridden and rejects contradictory flags', () =>
  fixture('error', ({ invoke, flows, calls }) => {
    assert.equal(invoke(['workflow', 'test', '--fast']).status, 1);
    const flow = flows.list()[0];
    const count = calls().length;
    assert.equal(invoke(['workflow', 'resume', flow.id], { mode: 'pass' }).status, 0);
    assert.ok(
      calls()
        .slice(count)
        .every((c) => requestedTier(c) === 'service_tier="fast"'),
    );
    const before = calls().length;
    const conflict = invoke(['workflow', 'bad', '--fast', '--no-fast']);
    assert.equal(conflict.status, 2);
    assert.equal(calls().length, before);
    assert.equal(invoke(['workflow', 'status', flow.id, '--fast']).status, 2);
  }));
test('manual tasks accept speed overrides and retain them on resume', () =>
  fixture('pass', ({ invoke, runs, calls }) => {
    assert.equal(invoke(['plan', 'manual', '--no-fast']).status, 0);
    const run = runs.list()[0];
    assert.equal(run.speed, 'standard');
    assert.equal(invoke(['resume', run.id, 'continue']).status, 0);
    assert.equal(requestedTier(calls()[1]), 'service_tier="default"');
    assert.equal(invoke(['resume', run.id, 'continue', '--fast']).status, 0);
    assert.equal(requestedTier(calls()[2]), 'service_tier="fast"');
    assert.equal(runs.read(run.id).speed, 'fast');
  }));
