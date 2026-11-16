import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { runCodex, consumeEvents } from '../dist/adapters/codex.js';
import { executeOperation } from '../dist/runtime/executor.js';
import { Journal } from '../dist/runtime/journal.js';
import { classify, fault } from '../dist/runtime/faults.js';
import { recoverProcesses } from '../dist/runtime/process.js';
import { ownerAlive, processIdentity } from '../dist/runtime/identity.js';
import { assertCodexProtocol } from '../dist/adapters/protocol.js';
import { lockWorkspace, waitForWorkspace } from '../dist/storage/workspace-lock.js';
import { KernelStore, copySource, manifest, atomic, budgetSchema } from '../dist/kernel/store.js';
import { runKernel } from '../dist/kernel/runner.js';
import { agent } from '../dist/kernel/agent.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) {
  for (let i = 0; i < 200; i++) {
    if (predicate()) return;
    await sleep(10);
  }
  assert.fail('timed out waiting for fixture');
}
function fixture(mode = 'reconnect') {
  const root = mkdtempSync(join(tmpdir(), 'sihq-recovery-'));
  const cwd = join(root, 'workspace'),
    directory = join(root, 'record');
  mkdirSync(cwd);
  mkdirSync(directory);
  const executable = join(root, 'fake-codex.mjs');
  writeFileSync(
    executable,
    `#!${process.execPath}
import fs from 'node:fs';
import readline from 'node:readline';
import {spawn} from 'node:child_process';
const root=${JSON.stringify(root)}, mode=${JSON.stringify(mode)};
const file=root+'/turn.json';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
const notify=(method,params)=>send({method,params:{threadId:'thread-1',...params}});
const response=(id,result)=>send({id,result});
let active;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 fs.appendFileSync(root+'/requests.jsonl',JSON.stringify(m)+'\\n');
 if(m.method==='initialize') return response(m.id,{userAgent:'codex/0.169.0'});
 if(m.method==='initialized') return;
 if(m.method==='thread/read') return response(m.id,{thread:{id:'thread-1',status:{type:'notLoaded'},turns:fs.existsSync(file)?[JSON.parse(fs.readFileSync(file))]:[]}});
 if(m.method==='thread/start'||m.method==='thread/resume') return response(m.id,{thread:{id:'thread-1',turns:[]}});
 if(m.method==='turn/interrupt') {
  fs.writeFileSync(root+'/interrupted','yes'); response(m.id,{});
  return notify('turn/completed',{turn:{id:active,status:'interrupted',items:[]}});
 }
 if(m.method!=='turn/start') return;
 const n=fs.existsSync(root+'/count')?Number(fs.readFileSync(root+'/count'))+1:1;
 fs.writeFileSync(root+'/count',String(n)); active='turn-'+n;
 if(mode==='rejected-submit' && n===1) return send({id:m.id,error:{code:-32000,message:'server overloaded',data:{codexErrorInfo:'serverOverloaded'}}});
 let text=mode==='invalid-output'&&n===1?'invalid':JSON.stringify({ok:true});
 if(mode==='pipeline') {
  const schema=m.params.outputSchema.properties;
  let report;
  if(schema.hypothesis) report={task:'implement',familyId:'warp',algorithmFamily:'warp',references:[],borrowedIdeas:[],portabilityNotes:[],templateStrategy:'one template',parameterSpace:[],hypothesis:'test pipeline',changes:['edit kernel'],validation:['fixed tests'],expectedBenefit:'architecture'};
  else if(schema.verdict) report={verdict:'passed',summary:'checked',findings:[],limitations:[]};
  else if(schema.disposition) report={action:'stop',stopReason:'goal_converged',disposition:'retain',reason:'complete',nextHypothesis:'none',parent:'current',familyAction:'keep_open'};
  else { fs.writeFileSync(process.cwd()+'/src/kernel.cu','change-'+n); report={summary:'implemented',changes:['kernel.cu'],parameters:[],remaining:[]}; }
  text=JSON.stringify(report);
 }
 const turn={id:active,status:'completed',items:[{id:'reply-'+n,type:'agentMessage',text}]};
 if(mode==='unknown-submit') { process.exit(19); }
 notify('turn/started',{turn:{id:active,status:'inProgress',items:[]}});
 response(m.id,{turn:{id:active,status:'inProgress',items:[]}});
 if(mode==='hang') {
  const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});
  fs.writeFileSync(root+'/child',JSON.stringify({pid:child.pid})); return;
 }
 if(mode==='permanent') {
  const error={message:'401 unauthorized (upstream 503 was earlier)',codexErrorInfo:{httpConnectionFailed:{httpStatusCode:401}}};
  notify('error',{turnId:active,error,willRetry:false});
  return notify('turn/completed',{turn:{...turn,status:'failed',error}});
 }
 if(mode==='protocol') return notify('error',{turnId:active,error:{message:'bad'},willRetry:'yes'});
 if(mode==='crash-completed' && n===1) {
  fs.appendFileSync(root+'/workspace/source','mutation\\n'); fs.writeFileSync(file,JSON.stringify(turn)); process.exit(17);
 }
 if(mode==='partial' && n===1) {
  fs.writeFileSync(root+'/workspace/source','partial');
  fs.writeFileSync(file,JSON.stringify({...turn,status:'interrupted',items:[]})); process.exit(18);
 }
 if(mode==='partial') {
  if(fs.readFileSync(root+'/workspace/source','utf8')!=='partial') throw Error('lost partial edit');
  fs.writeFileSync(root+'/workspace/source','partial+finished');
 }
 if(mode==='reconnect') notify('error',{turnId:active,error:{message:'routing temporarily unavailable',codexErrorInfo:'serverOverloaded'},willRetry:true});
 fs.writeFileSync(file,JSON.stringify(turn));
 notify('thread/tokenUsage/updated',{turnId:active,tokenUsage:{last:{inputTokens:3,outputTokens:2}}});
 notify('item/completed',{turnId:active,item:turn.items[0]});
 notify('turn/completed',{turn});
});
`,
    { mode: 0o755 },
  );
  const events = [];
  const options = {
    cwd,
    codexPath: executable,
    transport: 'app-server',
    model: 'fixture',
    sandboxMode: 'workspace-write',
    startupTimeoutMs: 500,
    execution: {
      directory,
      id: 'logical-stage',
      capture: () =>
        existsSync(join(cwd, 'source')) ? readFileSync(join(cwd, 'source'), 'utf8') : '',
    },
    recoveryPolicy: { windowMs: 3000, maxDelayMs: 1, idleMs: 1000 },
    onExecutionEvent: (type, data) => events.push({ type, data }),
    renderEvent: () => {},
    validateOutput: (answer) => assert.deepEqual(JSON.parse(answer), { ok: true }),
  };
  return {
    root,
    cwd,
    directory,
    events,
    options,
    executable,
    run: (signal = new AbortController().signal) => runCodex('implement once', signal, options),
    count: () => Number(readFileSync(join(root, 'count'))),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
test('app-server reconnect notices leave the current turn alive', async () => {
  const f = fixture();
  try {
    assert.equal(await f.run(), '{"ok":true}');
    assert.equal(f.count(), 1);
    assert.ok(f.events.some((e) => e.type === 'provider.reconnecting'));
    assert.ok(!f.events.some((e) => e.type === 'execution.retry'));
    assert.equal(new Journal(f.directory).operations()[0].phase, 'completed');
  } finally {
    f.cleanup();
  }
});
test('lost completion acknowledgement is reconciled from turn history without another mutation', async () => {
  const f = fixture('crash-completed');
  try {
    assert.equal(await f.run(), '{"ok":true}');
    assert.equal(f.count(), 1);
    assert.equal(readFileSync(join(f.cwd, 'source'), 'utf8'), 'mutation\n');
    assert.equal(await f.run(), '{"ok":true}');
    assert.equal(f.count(), 1);
  } finally {
    f.cleanup();
  }
});
test('partial edits survive a failed process and recovery continues the same stage', async () => {
  const f = fixture('partial');
  try {
    await f.run();
    assert.equal(f.count(), 2);
    assert.equal(readFileSync(join(f.cwd, 'source'), 'utf8'), 'partial+finished');
    const requests = readFileSync(join(f.root, 'requests.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.match(
      requests.filter((r) => r.method === 'turn/start')[1].params.input[0].text,
      /不重复应用/,
    );
  } finally {
    f.cleanup();
  }
});
test('structured permanent errors stop without retrying incidental status text', async () => {
  const f = fixture('permanent');
  try {
    await assert.rejects(
      f.run(),
      (error) => error.failure.kind === 'configuration' && error.failure.status === 401,
    );
    assert.equal(f.count(), 1);
  } finally {
    f.cleanup();
  }
});
test('model output corrections are separate from transport retries', async () => {
  const f = fixture('invalid-output');
  try {
    await f.run();
    assert.equal(f.count(), 2);
    assert.equal(f.events.filter((e) => e.type === 'execution.correction').length, 1);
    assert.equal(f.events.filter((e) => e.type === 'execution.retry').length, 0);
  } finally {
    f.cleanup();
  }
});
test('malformed protocol metadata fails closed', async () => {
  const f = fixture('protocol');
  try {
    await assert.rejects(f.run(), /willRetry/);
    assert.equal(f.count(), 1);
  } finally {
    f.cleanup();
  }
});
test('an unacknowledged submit with no matching history is not blindly duplicated', async () => {
  const f = fixture('unknown-submit');
  f.options.recoveryPolicy.windowMs = 200;
  try {
    await assert.rejects(f.run(), /截止|窗口耗尽/);
    assert.equal(f.count(), 1);
  } finally {
    f.cleanup();
  }
});
test('an explicitly rejected submit can retry without waiting for nonexistent turn history', async () => {
  const f = fixture('rejected-submit');
  try {
    assert.equal(await f.run(), '{"ok":true}');
    assert.equal(f.count(), 2);
    assert.equal(f.events.filter((e) => e.type === 'execution.retry').length, 1);
    const requests = readFileSync(join(f.root, 'requests.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map(JSON.parse);
    assert.equal(requests.filter((r) => r.method === 'thread/read').length, 0);
  } finally {
    f.cleanup();
  }
});
test('cancellation interrupts the turn and drains tool descendants before returning', async () => {
  const f = fixture('hang');
  const controller = new AbortController();
  try {
    const promise = f.run(controller.signal);
    void promise.catch(() => {});
    await until(() => existsSync(join(f.root, 'child')));
    const child = processIdentity(JSON.parse(readFileSync(join(f.root, 'child'))).pid);
    controller.abort(new Error('user stop'));
    await assert.rejects(promise, /user stop/);
    assert.ok(existsSync(join(f.root, 'interrupted')));
    assert.equal(ownerAlive(child), false);
    assert.deepEqual(readdirSync(join(f.directory, 'processes')), []);
  } finally {
    f.cleanup();
  }
});
test('completed outputs cannot be reused after external source changes', async () => {
  const f = fixture();
  try {
    await f.run();
    writeFileSync(join(f.cwd, 'source'), 'external change');
    await assert.rejects(f.run(), /源码已变化/);
    assert.equal(f.count(), 1);
  } finally {
    f.cleanup();
  }
});
test('legacy reconnect notices do not close the iterator before completion', async () => {
  let reached = false;
  async function* stream() {
    yield { type: 'error', message: 'Reconnecting... 2/5 (workspace routing discovery failed)' };
    reached = true;
    yield { type: 'turn.completed', usage: { input_tokens: 0, output_tokens: 0 } };
  }
  await consumeEvents(stream(), undefined, false, () => {});
  assert.equal(reached, true);
});
test('recovery deadline cancels an in-flight retry, not only the next backoff', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-deadline-'));
  let tries = 0,
    cancelled = false;
  try {
    await assert.rejects(
      executeOperation({
        journal: new Journal(root),
        id: 'hang',
        identity: {},
        signal: new AbortController().signal,
        policy: { windowMs: 80, maxDelayMs: 1, idleMs: 10000 },
        async invoke(signal) {
          if (++tries === 1) throw Object.assign(new Error('unavailable'), { status: 503 });
          await new Promise((resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => {
                cancelled = true;
                reject(signal.reason);
              },
              { once: true },
            ),
          );
        },
      }),
      /截止|窗口耗尽/,
    );
    assert.equal(tries, 2);
    assert.equal(cancelled, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('transactional checkpoints survive a killed writer and ignore stale JSON exports', () => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-checkpoint-'));
  try {
    const journal = new Journal(root);
    journal.checkpoint('state.json', { stage: 'plan' });
    const result = spawnSync(process.execPath, [
      '--input-type=module',
      '-e',
      `
      import {DatabaseSync} from 'node:sqlite';
      const db=new DatabaseSync(${JSON.stringify(journal.file)});
      db.exec('BEGIN IMMEDIATE'); db.prepare('UPDATE checkpoints SET value=?').run('{"stage":"develop"}');
      process.kill(process.pid,'SIGKILL');
    `,
    ]);
    assert.equal(result.signal, 'SIGKILL');
    writeFileSync(join(root, 'state.json'), '{invalid export');
    assert.deepEqual(journal.readCheckpoint('state.json'), { stage: 'plan' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('worker crash recovery terminates orphaned owned processes before takeover', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-orphan-'));
  try {
    const code = `import {managedSpawn} from ${JSON.stringify(new URL('../dist/runtime/process.js', import.meta.url).href)};
      import fs from 'node:fs';
      const p=managedSpawn([process.execPath,'-e',"setInterval(()=>{},1000)"],{stdio:'ignore'},${JSON.stringify(root)});
      fs.writeFileSync(${JSON.stringify(join(root, 'child'))},String(p.child.pid));
      process.kill(process.pid,'SIGKILL');`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: 'ignore' });
    await once(child, 'exit');
    const identity = processIdentity(Number(readFileSync(join(root, 'child'))));
    await recoverProcesses(root);
    assert.equal(ownerAlive(identity), false);
    assert.deepEqual(readdirSync(join(root, 'processes')), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('failure classification keeps control, integrity and validation out of network retries', () => {
  assert.equal(classify(fault('output', 'JSON', 'invalid', 'correct')).action, 'correct');
  assert.equal(classify(fault('integrity', 'SOURCE', 'changed')).action, 'stop');
  assert.equal(classify({ status: 401, message: 'HTTP 503' }).action, 'stop');
  assert.equal(classify({ status: 429, retryAfterMs: 123 }).retryAfterMs, 123);
  assert.equal(classify({ status: 429, headers: { 'retry-after': '2' } }).retryAfterMs, 2000);
  const circular = new Error('unknown');
  circular.cause = circular;
  assert.equal(classify(circular).kind, 'unknown');
});

test('only one caller can execute the same logical operation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-exclusion-'));
  let unblock,
    calls = 0;
  const gate = new Promise((resolve) => {
    unblock = resolve;
  });
  const options = {
    journal: new Journal(root),
    id: 'same',
    identity: {},
    signal: new AbortController().signal,
    invoke: async () => {
      calls++;
      await gate;
      return 'done';
    },
  };
  try {
    const first = executeOperation(options);
    await until(() => calls === 1);
    await assert.rejects(executeOperation(options), /正在运行/);
    unblock();
    assert.equal(await first, 'done');
    assert.equal(calls, 1);
  } finally {
    unblock();
    rmSync(root, { recursive: true, force: true });
  }
});
test('read-only mutations are integrity failures and never become retryable output errors', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-readonly-'));
  let source = 'original',
    calls = 0;
  try {
    await assert.rejects(
      executeOperation({
        journal: new Journal(root),
        id: 'readonly',
        identity: {},
        signal: new AbortController().signal,
        capture: () => source,
        readOnly: true,
        invoke: async () => {
          calls++;
          source = 'changed';
          throw fault('output', 'INVALID', 'bad output', 'correct');
        },
      }),
      (error) => error.failure.kind === 'integrity',
    );
    assert.equal(calls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('resource contention waits and cancellation releases the waiter without taking the lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-resource-'));
  const release = lockWorkspace(root),
    cancel = new AbortController();
  let waiting = false;
  try {
    const pending = waitForWorkspace(root, cancel.signal, () => {
      waiting = true;
    });
    assert.equal(waiting, true);
    cancel.abort(new Error('stop waiting'));
    await assert.rejects(pending, { name: 'AbortError' });
    assert.throws(() => lockWorkspace(root), /正在运行/);
    release();
    const next = await waitForWorkspace(root, new AbortController().signal);
    next();
  } finally {
    release();
    rmSync(root, { recursive: true, force: true });
  }
});
test('protocol upgrades require explicit compatibility verification', () => {
  assert.doesNotThrow(() => assertCodexProtocol('codex_vscode/0.169.0 (Linux)'));
  const old = process.env.SIHQ_ALLOW_UNTESTED_CODEX;
  delete process.env.SIHQ_ALLOW_UNTESTED_CODEX;
  try {
    assert.throws(() => assertCodexProtocol('codex/9.1.0'), /协议版本未验证/);
  } finally {
    if (old !== undefined) process.env.SIHQ_ALLOW_UNTESTED_CODEX = old;
  }
});
test('legacy record migration preserves an original backup and commits state and result together', () => {
  const root = mkdtempSync(join(tmpdir(), 'sihq-migration-'));
  try {
    writeFileSync(join(root, 'state.json'), '{"stage":"plan"}');
    const journal = new Journal(root);
    const operation = {
      id: 'op',
      identity: 'id',
      phase: 'completed',
      attempt: 1,
      corrections: 0,
      createdAt: 1,
      updatedAt: 1,
      lastProgressAt: 1,
      result: { ok: true },
    };
    journal.checkpoint('state.json', { stage: 'develop' }, operation);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'legacy-records/state.json'))), {
      stage: 'plan',
    });
    assert.equal(journal.readCheckpoint('state.json').stage, 'develop');
    assert.deepEqual(journal.operation('op').result, { ok: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('five-stage kernel pipeline uses app-server, commits results and archives the candidate', async () => {
  const f = fixture('pipeline'),
    previousPath = process.env.PATH,
    previousTransport = process.env.SIHQ_CODEX_TRANSPORT;
  try {
    writeFileSync(join(f.root, 'codex'), readFileSync(f.executable), { mode: 0o755 });
    writeFileSync(join(f.root, 'package.json'), '{"type":"module"}');
    process.env.PATH = f.root + ':' + previousPath;
    process.env.SIHQ_CODEX_TRANSPORT = 'app-server';
    mkdirSync(join(f.cwd, 'src'));
    mkdirSync(join(f.cwd, 'include'));
    writeFileSync(join(f.cwd, 'src/kernel.cu'), 'original');
    const store = new KernelStore(join(f.root, 'kernel')),
      id = randomUUID(),
      root = store.dir(id);
    mkdirSync(root);
    copySource(f.cwd, join(root, 'baseline'));
    const config = { model: 'fixture', reasoningEffort: 'medium', speed: 'standard' };
    const state = {
      id,
      project: f.cwd,
      createdAt: 'now',
      updatedAt: '',
      status: 'ready',
      stage: 'baseline',
      experiment: 1,
      budget: budgetSchema.parse({ experiments: 1 }),
      usedSeconds: 0,
      calls: 0,
      tokens: 0,
      profile: 'smoke',
      sizes: [32],
      blocks: [4],
      iterations: 10,
      roles: { planner: config, developer: config, reviewer: config },
      parent: join(root, 'baseline'),
      threads: {},
      attempts: {},
      results: [],
    };
    store.save(state);
    atomic(join(root, 'control.json'), { action: 'run' });
    let checks = 0;
    await runKernel(id, store, {
      agent,
      async verify(s, r, source, destination, performance) {
        checks++;
        mkdirSync(destination, { recursive: true });
        const evidence = {
          passed: true,
          source: manifest(source),
          architectures: [80, 90, 120],
          sizes: s.sizes,
          profile: s.profile,
          performance: [],
          log: 'fixture',
          targetRuntimeVerified: false,
        };
        atomic(join(destination, 'evidence.json'), evidence);
        return evidence;
      },
    });
    const end = store.read(id);
    assert.equal(end.status, 'completed', end.error);
    assert.equal(end.calls, 6);
    assert.equal(checks, 3);
    assert.equal(end.results.length, 1);
    assert.equal(end.results[0].eligible, true);
    assert.equal(
      readFileSync(join(root, 'experiments/1/archived/src/kernel.cu'), 'utf8'),
      'change-4',
    );
    assert.equal(
      store
        .journal(id)
        .operations()
        .filter((operation) => operation.phase === 'completed').length,
      6,
    );
    assert.ok(existsSync(join(root, 'experiments/1/EXPERIMENT.md')));
  } finally {
    process.env.PATH = previousPath;
    if (previousTransport === undefined) delete process.env.SIHQ_CODEX_TRANSPORT;
    else process.env.SIHQ_CODEX_TRANSPORT = previousTransport;
    f.cleanup();
  }
});
