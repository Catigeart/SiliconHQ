#!/usr/bin/env node
import { kernelCli } from './kernel/cli.js';
import { parseSpeedArgs } from './config/speed.js';
import { startChat } from './chat/repl.js';
import { ChatStore } from './storage/chats.js';
import { startInteractive } from './interactive.js';
import { RunStore } from './storage/runs.js';
import { WorkflowStore } from './storage/workflows.js';
import { lockWorkspace } from './storage/workspace-lock.js';
import { prepareTask, type TaskRequest } from './execution/prepare.js';
import { executeTask, taskExitCode } from './execution/tasks.js';
import { runWorkflow, resumeWorkflow, continueWorkflow } from './workflow/runner.js';

const usage = '执行命令支持 [--fast|--no-fast]；用法：llm-coder chat | chat resume <chat-id> | run "任务" | plan "需求" | implement <plan-id> | review <实现-id> | list | resume <run-id> "指令" | workflow "需求" [--max-repairs 0|1|2] | workflow status <id> | workflow resume <id> | workflow continue <id> "新需求" | workflow list';
async function withSignal<T>(fn: (signal: AbortSignal)=>Promise<T>): Promise<T> {
  const controller=new AbortController();const cancel=()=>controller.abort();
  process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
  try{return await fn(controller.signal);}finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
}
async function main(): Promise<void> {
  let args=process.argv.slice(2);const command=args[0];
  if(command==='kernel'){await kernelCli(args.slice(1));return;}
  if(!['run','plan','implement','review','list','resume','workflow','chat'].includes(command??'') || (command==='resume' && args[1]?.startsWith('-'))) {startInteractive();return;}
  let speed;
  try { const parsed=parseSpeedArgs(args); args=parsed.args; speed=parsed.speed; }
  catch(error) {console.error(String(error));process.exitCode=2;return;}
  if(speed && (command==='list' || (['chat','workflow'].includes(command!) && ['list','status'].includes(args[1]??'')))) {
    console.error('查询命令不接受速度选项');process.exitCode=2;return;
  }
  if(command==='chat') {
    if(args.length===1) {await startChat(undefined,speed);return;}
    if(args[1]==='resume' && args.length===3) {await startChat(args[2],speed);return;}
    if(args[1]==='list' && args.length===2) {for(const chat of new ChatStore().list())console.log(`${chat.id}\t${chat.cwd}\t${chat.updatedAt}`);return;}
    console.error('用法：llm-coder chat | chat resume <chat-id> | chat list');process.exitCode=2;return;
  }
  if(command==='workflow') {
    const flows=new WorkflowStore();
    if(args[1]==='status' && args.length===3) {console.log(JSON.stringify(flows.read(args[2]!),null,2));return;}
    if(args[1]==='continue' && args.length===4) {
      const flow=await withSignal(signal=>continueWorkflow(args[2]!,args[3]!,signal,undefined,speed));
      process.exitCode=flow.status==='passed'?0:flow.status==='cancelled'?130:1;return;
    }
    if(args[1]==='resume' && args.length===3) {
      const flow=await withSignal(signal=>resumeWorkflow(args[2]!,signal,undefined,speed));
      process.exitCode=flow.status==='passed'?0:flow.status==='cancelled'?130:1;return;
    }
    if(args[1]==='list' && args.length===2) {for(const flow of flows.list())console.log(`${flow.id}\t${flow.status}\t${flow.stage}\t${JSON.stringify(flow.prompt)}`);return;}
    const maxRepairs=args.length===2?2:args.length===4 && args[2]==='--max-repairs' && /^[012]$/.test(args[3]??'')?Number(args[3]):NaN;
    if(!Number.isInteger(maxRepairs) || !args[1]?.trim() || ['status','list','resume','continue'].includes(args[1])) {console.error(usage);process.exitCode=2;return;}
    const flow=await withSignal(signal=>runWorkflow(args[1]!,process.cwd(),signal,maxRepairs,undefined,speed));
    process.exitCode=flow.status==='passed'?0:flow.status==='cancelled'?130:1;return;
  }
  const store=new RunStore();
  if(command==='list' && args.length===1) {
    const runs=store.list();if(!runs.length)console.log('暂无运行记录');
    for(const run of runs)console.log(`${run.id}\t${run.status}${run.reviewVerdict?'/'+run.reviewVerdict:run.implementationOutcome?'/'+run.implementationOutcome:''}\t${run.updatedAt}\t${JSON.stringify(run.prompt)}`);
    return;
  }
  let request: TaskRequest;
  if((command==='run'||command==='plan') && args.length===2 && args[1]?.trim()) request={command,prompt:args[1],cwd:process.cwd()};
  else if((command==='implement'||command==='review') && args.length===2)request={command,sourceId:args[1]!};
  else if(command==='resume' && args.length===3 && args[2]?.trim())request={command,sourceId:args[1]!,prompt:args[2]};
  else {console.error(usage);process.exitCode=2;return;}
  const cwd='cwd' in request?request.cwd:'sourceId' in request?store.read(request.sourceId).cwd:request.workflow.cwd;
  const unlock=lockWorkspace(cwd);
  try {
    const {run,prompt}=prepareTask(store,request);
    if(speed) run.speed=speed;
    process.exitCode=taskExitCode(await withSignal(signal=>executeTask(store,run,prompt,signal)));
  }finally{unlock();}
}
main().catch(error=>{console.error(`llm-coder: ${error.message}`);process.exitCode=1;});
