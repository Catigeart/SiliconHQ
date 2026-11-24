import { posixCodexTest as test } from './fixtures/posix-codex.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { ChatStore } from '../dist/storage/chats.js';
import { WorkflowStore } from '../dist/storage/workflows.js';

function fixture(mode = 'pass') {
  const root = mkdtempSync(join(tmpdir(), 'llm-chat-'));
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
const index=args.indexOf('--output-schema');const schema=index<0?null:JSON.parse(fs.readFileSync(args[index+1],'utf8'));
const kind=!schema?'chat':schema.properties.goal?'plan':schema.properties.outcome?'implement':'review';
const file=process.env.HOME+'/calls';const calls=fs.existsSync(file)?fs.readFileSync(file,'utf8').trim().split('\\n').map(JSON.parse):[];
fs.appendFileSync(file,JSON.stringify({kind,args,prompt})+'\\n');
const threadId=args.includes('resume')?args[args.indexOf('resume')+1]:kind+'-'+calls.length;
const emit=event=>console.log(JSON.stringify(event));
emit({type:'thread.started',thread_id:threadId});
if(process.env.CHAT_MODE==='hang_first' && kind==='chat' && calls.length===0) {
 emit({type:'item.started',item:{id:'tool',type:'command_execution',command:'fixture-active',status:'in_progress',aggregated_output:''}});
 await new Promise(resolve=>setTimeout(resolve,30000));
}
if(process.env.CHAT_MODE==='handoff_error' && kind==='chat' && prompt.includes('请根据刚结束的流程资料')) { emit({type:'turn.failed',error:{message:'handoff unavailable'}});process.exit(0); }
let answer;
if(kind==='chat') answer=prompt.includes('解释一下刚才')?(prompt.includes('file.mjs')?'刚才修改了 file.mjs':'没有流程上下文'):prompt.includes('请根据刚结束的流程资料')?'已完成：新增 file.mjs，测试通过。':'项目结构已分析。';
if(kind==='plan')answer=JSON.stringify({goal:'demo',steps:[{description:'implement',files:['file.mjs'],validation:'test'}],acceptanceCriteria:['works'],risks:[]});
if(kind==='implement')answer=JSON.stringify({summary:'added file.mjs',outcome:'implemented',changes:[{path:'file.mjs',description:'demo change'}],validations:[{command:'node --test',result:'passed',evidence:'fixture'}],remaining:[]});
if(kind==='review')answer=JSON.stringify({verdict:'passed',summary:'verified',criteria:[{criterion:'works',result:'passed',evidence:'fixture'}],findings:[],checks:[],limitations:[]});
emit({type:'item.completed',item:{type:'agent_message',id:'reply',text:answer}});
emit({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}});
`,
    { mode: 0o755 },
  );
  const env = {
    ...process.env,
    SIHQ_CODEX_TRANSPORT: 'exec',
    SIHQ_RECOVERY_WINDOW_MS: '0',
    SIHQ_OUTPUT_CORRECTIONS: '0',
    HOME: root,
    PATH: bin + ':' + process.env.PATH,
    CHAT_MODE: mode,
  };
  const cli = resolve('dist/cli.js');
  return {
    root,
    repo,
    env,
    cli,
    chats: new ChatStore(join(root, '.llm-coder', 'chats')),
    flows: new WorkflowStore(join(root, '.llm-coder', 'workflows')),
    invoke: (input, args = ['chat'], cwd = repo) =>
      spawnSync(process.execPath, [cli, ...args], {
        input,
        cwd,
        env,
        encoding: 'utf8',
        timeout: 15000,
      }),
    calls: () => readFileSync(join(root, 'calls'), 'utf8').trim().split('\n').map(JSON.parse),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

test('persistent chat runs workflow, hands results back and answers a follow-up', () => {
  const f = fixture();
  try {
    const result = f.invoke(
      '分析一下项目结构\n/workflow 加入配置文件支持\n解释一下刚才的修改\n/status\n/exit\n不应执行\n',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /sihq · /);
    assert.match(result.stdout, /助手 > 项目结构已分析/);
    assert.match(result.stdout, /\[astra 规划\]/);
    assert.match(result.stdout, /\[sol 实现\]/);
    assert.match(result.stdout, /\[terra 检查\]/);
    assert.match(result.stdout, /助手 > 刚才修改了 file.mjs/);
    assert.ok(!result.stdout.includes('"acceptanceCriteria"'));
    assert.ok(!result.stdout.includes('"outcome"'));
    assert.deepEqual(
      f.calls().map((c) => c.kind),
      ['chat', 'plan', 'implement', 'review', 'chat', 'chat'],
    );
    const [chat] = f.chats.list();
    const [flow] = f.flows.list();
    assert.equal(chat.latestWorkflowId, flow.id);
    assert.equal(chat.threadId, 'chat-0');
    for (const call of [f.calls()[4], f.calls()[5]]) {
      assert.ok(call.args.includes('chat-0'));
      assert.ok(call.args.includes('resume'));
      assert.match(call.prompt, /file.mjs/);
      assert.match(call.prompt, /"status":"passed"/);
    }
    assert.match(f.calls()[1].prompt, /项目结构已分析/);
    assert.ok(f.calls()[0].args.includes('read-only'));
  } finally {
    f.cleanup();
  }
});
test('chat survives process exit and resumes original cwd, session and saved model', () => {
  const f = fixture();
  try {
    assert.equal(f.invoke('分析项目\n/exit\n').status, 0);
    const [chat] = f.chats.list();
    writeFileSync(
      join(f.repo, 'sihq.config.json'),
      '{"roles":{"planner":{"model":"changed"},"developer":{"model":"changed"},"reviewer":{"model":"changed"}}}',
    );
    const result = f.invoke('继续\n/exit\n', ['chat', 'resume', chat.id], f.root);
    assert.equal(result.status, 0, result.stderr);
    const call = f.calls()[1];
    assert.ok(call.args.includes(chat.threadId));
    assert.ok(call.args.includes(f.repo));
    assert.ok(call.args.includes(chat.model));
    assert.equal(f.chats.list().length, 1);
    assert.match(f.invoke('', ['chat', 'list']).stdout, new RegExp(chat.id));
  } finally {
    f.cleanup();
  }
});
test('workflow handoff failure keeps result available to next user message', () => {
  const f = fixture('handoff_error');
  try {
    const result = f.invoke('/workflow 做一个 demo\n解释一下刚才的修改\n/exit\n');
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /主对话汇报失败/);
    assert.match(result.stdout, /刚才修改了 file.mjs/);
    assert.equal(f.flows.list()[0].status, 'passed');
  } finally {
    f.cleanup();
  }
});
test('invalid slash commands and failed resume leave the input loop usable', () => {
  const f = fixture();
  try {
    const result = f.invoke(
      '/unknown\n/workflow\n/resume bad-id\n/status\n/help\n分析项目\n/exit\n',
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /未知命令/);
    assert.match(result.stdout, /用法：\/workflow/);
    assert.match(result.stdout, /无效的记录 ID/);
    assert.match(result.stdout, /还没有流程/);
    assert.equal(f.calls().length, 1);
  } finally {
    f.cleanup();
  }
});
test('same chat cannot be opened concurrently', () => {
  const f = fixture();
  try {
    f.invoke('/exit\n');
    const [chat] = f.chats.list();
    const release = f.chats.lock(chat.id);
    try {
      const result = f.invoke('/exit\n', ['chat', 'resume', chat.id]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /正在运行/);
    } finally {
      release();
    }
  } finally {
    f.cleanup();
  }
});
test('Ctrl+C cancels active turn and allows another message without exiting', async () => {
  const f = fixture('hang_first');
  let child;
  try {
    child = spawn(process.execPath, [f.cli, 'chat'], {
      cwd: f.repo,
      env: f.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let output = '';
    let error = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      error += data;
    });
    const waitFor = (text) =>
      new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          clearInterval(timer);
          reject(new Error('timeout: ' + output + error));
        }, 8000);
        const timer = setInterval(() => {
          if (output.includes(text)) {
            clearTimeout(timeout);
            clearInterval(timer);
            resolve();
          }
        }, 20);
      });
    const closed = once(child, 'close');
    child.stdin.write('分析项目\n');
    await waitFor('fixture-active');
    child.kill('SIGINT');
    await waitFor('已取消当前任务');
    child.stdin.end('继续\n/exit\n');
    const [code] = await closed;
    assert.equal(code, 0, error);
    assert.match(output, /助手 > 项目结构已分析/);
    assert.equal(f.calls().length, 2);
    assert.ok(f.calls()[1].args.includes('chat-0'));
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    f.cleanup();
  }
});

test('chat continues an existing workflow and reports current round to main conversation', () => {
  const f = fixture();
  try {
    assert.equal(f.invoke('/workflow first\n/exit\n').status, 0);
    const [chat] = f.chats.list();
    const [first] = f.flows.list();
    const result = f.invoke(
      `/continue ${first.id} second requirement\n/status\n解释一下刚才的修改\n/exit\n`,
      ['chat', 'resume', chat.id],
    );
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /第 2 轮/);
    assert.match(result.stdout, /轮次：2/);
    assert.equal(f.flows.list().length, 1);
    assert.equal(f.flows.read(first.id).rounds.length, 1);
    assert.match(f.calls().at(-1).prompt, /"round":2/);
    assert.match(f.calls().at(-1).prompt, /second requirement/);
  } finally {
    f.cleanup();
  }
});

test('chat speed and workflow speed are independent and continuation can override', () => {
  const f = fixture();
  try {
    assert.equal(f.invoke('/workflow --fast first\n/exit\n', ['chat', '--no-fast']).status, 0);
    const chat = f.chats.list()[0];
    const flow = f.flows.list()[0];
    assert.equal(chat.speed, 'standard');
    assert.equal(flow.speedOverride, 'fast');
    const calls = f.calls();
    for (const c of calls.slice(0, 3)) assert.ok(c.args.includes('service_tier="fast"'));
    assert.ok(calls[3].args.includes('service_tier="default"'));
    assert.equal(
      f.invoke(`/continue ${flow.id} --no-fast next\n/exit\n`, ['chat', 'resume', chat.id]).status,
      0,
    );
    assert.equal(f.flows.read(flow.id).speedOverride, 'standard');
    for (const c of f.calls().slice(4)) assert.ok(c.args.includes('service_tier="default"'));
  } finally {
    f.cleanup();
  }
});
