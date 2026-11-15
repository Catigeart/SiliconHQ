import { researchModeSchema } from './research.js';
import { writeResearchIndex } from './reports.js';
import { diagnose } from './diagnostics.js';
import { parseLimit, resolveBudget } from './budget.js';
import { mkdirSync, cpSync, existsSync, readFileSync, appendFileSync, openSync, closeSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { KernelStore, atomic, copySource, manifest, treeManifest, type State } from './store.js';
import { loadRoleConfig } from '../config/roles.js';
import { parseSpeedArgs } from '../config/speed.js';
import { runKernel } from './runner.js';

const help=`llm-coder kernel start <project> [--experiments 2] [--seconds 3600] [--calls 16] [--tokens 1000000] [--stage-seconds 600] [--time-only] [--research-mode algorithm-exploration|platform-tuning] [--attempts 2] [--smoke] [--objective "研究目标"] [--foreground] [--fast|--no-fast]
llm-coder kernel status <id> | list | experiments <id> | logs <id> [--follow]
llm-coder kernel pause <id> | stop <id> | resume <id> [--foreground]
llm-coder kernel research-mode <id> <algorithm-exploration|platform-tuning>
llm-coder kernel report <id>
llm-coder kernel diagnose <id> <codegen|kernels|paired> <baseline,实验编号> [--sizes 32,128] [--repeats 3]
llm-coder kernel steer <id> "下一轮优先 nb=512"
预算值接受正整数或 unlimited；--time-only 仅保留 --seconds 限制。到期或 stop 取消实验后由 planner 总结，收尾另计时间。`;
function alive(pid?:number){if(!pid)return false;try{process.kill(pid,0);return true;}catch{return false;}}
function launch(s:State,store:KernelStore){
  const fd=openSync(join(store.dir(s.id),'worker.log'),'a',0o600);
  const child=spawn(process.execPath,[resolve(process.argv[1]!),'kernel','worker',s.id],{detached:true,stdio:['ignore',fd,fd]});closeSync(fd);
  child.on('error',error=>console.error('启动后台进程失败：'+String(error)));child.unref();
  console.log(`kernel ${s.id}\n后台 PID ${child.pid}\n查看：llm-coder kernel status ${s.id}\n日志：${join(store.dir(s.id),'events.jsonl')}`);
}
export async function kernelCli(input:string[]):Promise<void>{
  if(!input.length||input[0]==='--help'){console.log(help);return;}
  const store=new KernelStore();const command=input[0];
  if(command==='start') {
    const parsed=parseSpeedArgs(input.slice(1));const args=parsed.args;const project=realpathSync(args.shift()??'');
    let researchMode=researchModeSchema.parse('algorithm-exploration');
    const budget:Record<string,number|null>={};let foreground=false,smoke=false,timeOnly=false,objective='持续研究可跨 A100/H800 调参的 FP32 warp-level 对角块求逆方案。';
    const names:Record<string,string>={'--experiments':'experiments','--seconds':'seconds','--calls':'calls','--tokens':'tokens','--stage-seconds':'stageSeconds','--attempts':'attempts'};
    while(args.length){const key=args.shift()!;if(key==='--research-mode'&&args.length)researchMode=researchModeSchema.parse(args.shift());else if(key==='--time-only')timeOnly=true;else if(key==='--objective'&&args.length)objective=args.shift()!;else if(key==='--foreground')foreground=true;else if(key==='--smoke')smoke=true;else if(names[key]&&args.length)budget[names[key]!]=parseLimit(args.shift()!);else throw new Error(help);}
    const limits=resolveBudget(budget,timeOnly);manifest(project);
    for(const file of ['common.hpp','reference.hpp','correctness.cpp','diagonal_workflow.cpp','benchmark_input.hpp','benchmark_input.cu','correctness_input.hpp','correctness_input.cu'])if(!existsSync(join(project,'tests',file)))throw new Error('缺少专用验证文件：'+file);
    const id=randomUUID(),root=store.dir(id);mkdirSync(root,{recursive:true,mode:0o700});
    copySource(project,join(root,'baseline'));mkdirSync(join(root,'trusted/tests'),{recursive:true});
    cpSync(join(project,'include'),join(root,'trusted/include'),{recursive:true});
    for(const file of ['common.hpp','reference.hpp','correctness.cpp','diagonal_workflow.cpp','benchmark_input.hpp','benchmark_input.cu','correctness_input.hpp','correctness_input.cu'])cpSync(join(project,'tests',file),join(root,'trusted/tests',file));
    atomic(join(root,'trusted-manifest.json'),treeManifest(join(root,'trusted')));
    const roles={planner:loadRoleConfig(project,'planner'),developer:loadRoleConfig(project,'developer'),reviewer:loadRoleConfig(project,'reviewer')};
    if(parsed.speed)for(const role of Object.values(roles))role.speed=parsed.speed;
    const s:State={researchMode,researchPolicyStart:1,sanitizerPolicy:'family-final-v1',performancePolicy:'ncu-base-pitched-v2',timeOnly,testPolicy:'split-gpu-v2',references:{guide:'/root/gpuhpc-workspace/trtri-ref',root:'/root/gpuhpc-workspace/references'},objective,id,project,createdAt:new Date().toISOString(),updatedAt:'',status:'ready',stage:'baseline',experiment:1,budget:limits,usedSeconds:0,calls:0,tokens:0,profile:smoke?'smoke':'full',sizes:smoke?[32]:[32,64,128,256,512,1024],blocks:[4],iterations:20,roles,parent:join(root,'baseline'),threads:{},attempts:{},results:[]};
    mkdirSync(join(root,'research'),{recursive:true});
    for(const name of ['README.txt','SOURCE_INDEX.txt','SOURCES.json'])cpSync(join(s.references!.guide,name),join(root,'research',name));
    atomic(join(root,'research-index-manifest.json'),treeManifest(join(root,'research')));
    store.save(s);atomic(join(root,'baseline-manifest.json'),manifest(join(root,'baseline')));atomic(join(root,'control.json'),{action:'run'});
    store.event(s,'created',{project,budget:limits,profile:s.profile});
    if(foreground){console.log(`kernel ${id}`);await runKernel(id,store);console.log(JSON.stringify(store.read(id),null,2));const end=store.read(id);process.exitCode=end.status==='blocked'||(end.status==='stopped'&&end.closeout?.status!=='completed')?1:0;}
    else launch(s,store);
    return;
  }
  if(command==='list'&&input.length===1){for(const s of store.list())console.log(`${s.id}\t${s.status}\t${s.stage}\t${s.experiment}/${s.budget.experiments??'unlimited'}\t${s.project}`);return;}
  const id=input[1];if(!id)throw new Error(help);const s=store.read(id),root=store.dir(id);
  if(command==='research-mode'&&input.length===3) {
    const mode=researchModeSchema.parse(input[2]);const unlock=store.lock(id);
    try {
      const state=store.read(id);
      if(!['paused','ready','blocked'].includes(state.status)||state.closeout)throw new Error('请先暂停任务，再切换研究模式');
      const previous={mode:state.researchMode,start:state.researchPolicyStart};
      state.researchMode=mode;state.researchPolicyStart=state.stage==='plan'||state.stage==='baseline'?state.experiment:state.experiment+1;
      store.save(state);store.event(state,'research.mode.changed',{previous,mode,effectiveExperiment:state.researchPolicyStart});
      writeResearchIndex(root,state);console.log(`研究模式：${mode}；从实验 ${state.researchPolicyStart} 的规划生效，预算和已完成证据保留。`);
    }finally{unlock();}return;
  }
  if(command==='report'&&input.length===2) {
    const unlock=store.lock(id);try{writeResearchIndex(root,s,true);console.log(join(root,'INDEX.md'));}finally{unlock();}return;
  }
  if(command==='diagnose'&&input.length>=4) {
    const unlock=store.lock(id);
    try {
      const kind=input[2],targets=input[3]!.split(',');let sizes=[32],repeats=3;
      for(let i=4;i<input.length;i+=2){if(input[i]==='--sizes')sizes=input[i+1]!.split(',').map(Number);else if(input[i]==='--repeats')repeats=Number(input[i+1]);else throw new Error(help);}
      const dest=join(root,'manual-diagnostics',new Date().toISOString().replaceAll(':','-'));
      const controller=new AbortController();const cancel=()=>controller.abort(new Error('人工取消诊断'));
      process.on('SIGINT',cancel);process.on('SIGTERM',cancel);
      try {const result=await diagnose(s,root,{task:kind==='paired'?'remeasure':'diagnose',diagnostics:[{kind,targets,sizes,repeats,reason:'人工明确请求诊断/复测'}]},dest,controller.signal);console.log(JSON.stringify({status:result.status,error:result.error,evidence:join(dest,'evidence.json')},null,2));if(result.status!=='completed')process.exitCode=1;}
      finally{process.off('SIGINT',cancel);process.off('SIGTERM',cancel);}
    }finally{unlock();}return;
  }
  if(command==='worker'&&input.length===2){await runKernel(id,store);return;}
  if(command==='status'&&input.length===2){console.log(JSON.stringify({...s,workerAlive:alive(s.workerPid),control:JSON.parse(readFileSync(join(root,'control.json'),'utf8'))},null,2));return;}
  if(command==='experiments'&&input.length===2){console.log(JSON.stringify(s.results,null,2));return;}
  if(command==='logs'&&(input.length===2||input.length===3&&input[2]==='--follow')){
    const file=join(root,'events.jsonl');
    if(input[2]){const child=spawn('tail',['-n','30','-F',file],{stdio:'inherit'});await new Promise<void>(resolve=>child.on('close',()=>resolve()));}
    else console.log(readFileSync(file,'utf8').trim().split('\n').slice(-30).join('\n'));return;
  }
  if(command==='pause'&&input.length===2){atomic(join(root,'control.json'),{action:'pause',at:new Date().toISOString()});console.log('已请求在当前阶段结束后暂停。');return;}
  if(command==='stop'&&input.length===2) {
    const finished=(state:State)=>state.closeout?.status==='completed'||(['completed','budget_exhausted'].includes(state.status)&&state.closeout?.status!=='failed');
    if(finished(s)){console.log('任务已结束；已有总结和归档保留。');return;}
    atomic(join(root,'control.json'),{action:'stop',at:new Date().toISOString()});
    // Paused/blocked campaigns have no worker to consume a control request.
    // Start one for closeout only; its first action observes the pending stop.
    let idle=false;
    try{const unlock=store.lock(id);unlock();idle=true;}catch(error){if(!/正在运行|EEXIST/.test(String(error)))throw error;}
    if(idle){const current=store.read(id);if(!finished(current))launch(current,store);}
    console.log('已请求取消当前实验，保存现场后由 planner 生成总结。收尾期间重复 stop 不会打断总结。');return;
  }
  if(command==='steer'&&input.length===3&&input[2]!.trim()){
    appendFileSync(join(root,'steering.jsonl'),JSON.stringify({at:new Date().toISOString(),text:input[2]})+'\n');console.log('已保存，下一次模型调用会收到人工意见。');return;
  }
  if(command==='resume'&&(input.length===2||input.length===3&&input[2]==='--foreground')) {
    if(s.closeout?.status==='completed'||(['completed','budget_exhausted'].includes(s.status)&&s.closeout?.status!=='failed'))throw new Error('任务已结束或预算耗尽，请新建有预算的任务');
    // Probe the process lock before resetting a pending pause/stop request.
    const unlock=store.lock(id);unlock();
    for(const failure of Object.values(s.networkFailures??{}))failure.startedAt=Date.now();store.save(s);
    atomic(join(root,'control.json'),{action:'run'});
    if(input[2]){await runKernel(id,store);const end=store.read(id);process.exitCode=end.status==='blocked'||(end.status==='stopped'&&end.closeout?.status!=='completed')?1:0;}else launch(s,store);return;
  }
  throw new Error(help);
}
