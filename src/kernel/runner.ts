import { validateResearchPlan, registerQuestion, validateResearchDecision, recordQuestionOutcome, questions } from './research.js';
import { diagnose, capabilities } from './diagnostics.js';
import { registerFamily, validateClosure, closeFamily, validateArchivedFinalization, validateFamilyAction } from './families.js';
import { writeExperimentReport, writeResearchIndex } from './reports.js';
import { sanitize, type SanitizerEvidence } from './sanitizer.js';
import { setTimeout as delay } from 'node:timers/promises';
import { reached, transient } from './budget.js';
import { finishCloseout } from './closeout.js';
import { recordReferences } from './references.js';
import { mkdirSync, existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { agent, type AgentInput, decisionSchema } from './agent.js';
import { verify, type Evidence } from './verify.js';
import { KernelStore, atomic, copySource, manifest, treeManifest, readJson, type State, type Stage } from './store.js';
import { lockWorkspace } from '../storage/workspace-lock.js';

export type Dependencies={agent:typeof agent;verify:typeof verify;sanitize?:typeof sanitize;diagnose?:typeof diagnose;retryDelay?:(ms:number,signal:AbortSignal)=>Promise<void>};
const production:Dependencies={agent,verify,sanitize,diagnose};
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b);}
function assertCandidate(path:string){
  if(readdirSync(path).some(name=>!['src','include','README.txt'].includes(name)))throw new Error('候选修改了允许范围外的文件；仅允许 src/ 和 include/');
  manifest(path);
}
export async function runKernel(id:string,store=new KernelStore(),deps:Dependencies=production):Promise<void> {
  const release=store.lock(id);const root=store.dir(id);const s=store.read(id);
  if(s.closeout?.status==='completed'||(['completed','budget_exhausted'].includes(s.status)&&s.closeout?.status!=='failed')){release();throw new Error('任务已结束或预算耗尽，不能自动续跑');}
  const abort=new AbortController();const experimentAbort=new AbortController();let requestedStop=false;let deadline=false;
  const started=Date.now(),previousSeconds=s.usedSeconds,previousCloseoutSeconds=s.closeout?.seconds??0;
  let experimentEndedAt:number|undefined=s.closeout?started:undefined;
  const updateTime=()=>{s.usedSeconds=previousSeconds+((experimentEndedAt??Date.now())-started)/1000;if(s.closeout)s.closeout.seconds=previousCloseoutSeconds+(Date.now()-(experimentEndedAt??Date.now()))/1000;s.heartbeat=new Date().toISOString();};
  const control=()=>existsSync(join(root,'control.json'))?readJson(join(root,'control.json')):{action:'run'};
  const interrupt=()=>{if(s.closeout)return;requestedStop=true;experimentAbort.abort(new Error('用户请求停止，准备总结'));};
  process.on('SIGTERM',interrupt);process.on('SIGINT',interrupt);
  s.status='running';s.workerPid=process.pid;delete s.error;store.save(s);
  const heartbeat=setInterval(()=>{
    try {
      updateTime();
      if(!s.closeout&&reached(s.usedSeconds,s.budget.seconds)){deadline=true;experimentAbort.abort(new Error('总运行时间预算耗尽'));}
      if(control().action==='stop')interrupt();
      store.save(s);
    }catch(error){abort.abort(error);}
  },500);
  const transition=(stage:Stage)=>{s.stage=stage;store.save(s);};
  const scoped=async<T>(fn:(signal:AbortSignal)=>Promise<T>):Promise<T>=>{
    const signals=[abort.signal,experimentAbort.signal];
    if(s.budget.stageSeconds!==null)signals.push(AbortSignal.timeout(s.budget.stageSeconds*1000));
    const signal=AbortSignal.any(signals);const result=await fn(signal);signal.throwIfAborted();return result;
  };
  const experimentDir=()=>join(root,'experiments',String(s.experiment));
  const work=()=>join(experimentDir(),'candidate');
  const promptContext=()=>JSON.stringify({baseline:join(root,'baseline'),parent:s.parent,artifacts:experimentDir(),readableIndex:join(root,'INDEX.md'),familySummary:join(root,'FAMILY.md'),objective:s.objective,experiment:s.experiment,profile:s.profile,sizes:s.sizes,budget:s.budget,researchMode:s.researchMode??'legacy',researchPolicyStart:s.researchPolicyStart,questions:questions(root),questionsSummary:join(root,'QUESTIONS.md'),capabilities,families:existsSync(join(root,'families.json'))?readJson(join(root,'families.json')):{},previous:s.results.slice(-8),allExperiments:join(root,'state.json'),research:{guide:join(root,'research/README.txt'),index:join(root,'research/SOURCE_INDEX.txt'),catalog:join(root,'research/SOURCES.json'),sourceRoot:s.references?.root,notes:join(root,'research-notes.json')},
    steering:existsSync(join(root,'steering.jsonl'))?readFileSync(join(root,'steering.jsonl'),'utf8'):'',
    reports:readdirSync(experimentDir()).filter(f=>f.endsWith('.json')).map(f=>{
      const data=readJson(join(experimentDir(),f));
      if(f==='diagnostics.json')return {file:join(experimentDir(),f),data:{status:data.status,error:data.error,reason:data.reason,requests:data.requests?.map((r:any)=>({kind:r.kind,targets:r.targets,sizes:r.sizes,reused:r.reused,origin:r.origin,results:r.results?.map((v:any)=>({target:v.target,nb:v.nb,repeat:v.repeat,log:v.log,csv:v.csv,logs:v.logs}))}))}};
      return {file:f,data};
    })});
  class PauseRequested extends Error {}
  async function model(kind:AgentInput['kind'],instruction:string):Promise<any> {
    const dir=experimentDir(),file=join(dir,kind+'.json'),meta=join(dir,kind+'-source.json');
    const before=manifest(work());assertCandidate(work());
    if(existsSync(file)&&existsSync(meta)&&same(before,readJson(meta)))return readJson(file);
    const attemptKey=`${s.experiment}:${kind}`,attemptLimit=s.budget.attempts===undefined?2:s.budget.attempts;
    const retries=s.networkFailures??={};
    if(!retries[attemptKey]&&reached(s.attempts[attemptKey]??0,attemptLimit))throw new Error(`阶段已达到${attemptLimit===2?'两':attemptLimit}次尝试上限，请检查记录并新建任务`);
    if(!retries[attemptKey])s.attempts[attemptKey]=(s.attempts[attemptKey]??0)+1;
    const stageStarted=Date.now();
    for(;;) {
      abort.signal.throwIfAborted();experimentAbort.signal.throwIfAborted();
      if(control().action==='pause')throw new PauseRequested('已在重试边界暂停');
      if(reached(s.calls,s.budget.calls)||reached(s.tokens,s.budget.tokens))throw new Error('MODEL_BUDGET');
      if(s.budget.stageSeconds!==null&&Date.now()-stageStarted>=s.budget.stageSeconds*1000)throw new Error('TimeoutError: 阶段总重试时间耗尽');
      s.calls++;store.save(s);store.event(s,'agent.started',{kind,attempt:s.attempts[attemptKey],networkRetry:retries[attemptKey]?.count??0});
      let result;
      try {
        const recovery=retries[attemptKey]?`\n上次调用因连接中断。继续已有会话，先检查已落盘修改，勿重复应用。调用前源码：${JSON.stringify(before)}；当前源码：${JSON.stringify(manifest(work()))}`:'';
        result=await scoped(signal=>deps.agent(s,store,{kind,cwd:work(),prompt:instruction+recovery+'\n当前实验资料：'+promptContext(),output:join(dir,kind+'.events.jsonl')},s.budget.stageSeconds===null?signal:AbortSignal.any([signal,AbortSignal.timeout(Math.max(1,s.budget.stageSeconds*1000-(Date.now()-stageStarted)))])));
      }catch(error) {
        assertCandidate(work());
        if(!['develop','refactor'].includes(kind)&&!same(before,manifest(work())))throw new Error('只读阶段修改了源码');
        if(!transient(error)||abort.signal.aborted||experimentAbort.signal.aborted){delete retries[attemptKey];throw error;}
        const retry=retries[attemptKey]??={count:0,startedAt:Date.now(),lastError:''};retry.count++;retry.lastError=String(error);
        const windowMs=(s.networkRetry?.windowSeconds??600)*1000;
        if(Date.now()-retry.startedAt>=windowMs){store.save(s);throw new Error('连接持续中断，重试窗口耗尽；现场已保存，修复网络后 resume：'+String(error));}
        const ms=Math.min((s.networkRetry?.maxDelaySeconds??60)*1000,1000*2**Math.min(retry.count-1,6))*(0.8+Math.random()*0.2);
        store.event(s,'agent.retry',{kind,count:retry.count,delayMs:Math.round(ms),error:String(error)});store.save(s);
        const until=Date.now()+Math.min(ms,windowMs-(Date.now()-retry.startedAt));
        if(deps.retryDelay)await deps.retryDelay(ms,AbortSignal.any([abort.signal,experimentAbort.signal]));
        else while(Date.now()<until) {
          if(control().action==='pause')throw new PauseRequested('已在网络重试等待中暂停');
          await delay(Math.min(250,until-Date.now()),undefined,{signal:AbortSignal.any([abort.signal,experimentAbort.signal])});
        }
        continue;
      }
      assertCandidate(work());
      if(!['develop','refactor'].includes(kind)&&!same(before,manifest(work())))throw new Error('只读阶段修改了源码');
      delete retries[attemptKey];atomic(file,result);atomic(meta,manifest(work()));store.event(s,'agent.completed',{kind});return result;
    }
  }
  async function decisionModel(kind:'decide'|'family_decide'|'diagnostic_decide',instruction:string,verified?:boolean):Promise<any> {
    const planFile=join(experimentDir(),'plan.json'),plan=existsSync(planFile)?readJson(planFile):undefined;
    let feedback='';
    for(let correction=0;;correction++) {
      const result=decisionSchema.parse(await model(kind,instruction+feedback));
      try{validateResearchDecision(s,plan,result);validateFamilyAction(result,kind==='family_decide',verified);return result;}
      catch(error){
        atomic(join(experimentDir(),`${kind}-invalid-${correction}.json`),{result,error:String(error)});
        rmSync(join(experimentDir(),kind+'.json'),{force:true});rmSync(join(experimentDir(),kind+'-source.json'),{force:true});
        if(correction>=2)throw error;
        feedback='\n仅修正决策结构并给出研究问题结论，不重新实验。校验失败：'+String(error);
      }
    }
  }
  async function check(name:string,performance:boolean):Promise<Evidence> {
    const dest=join(experimentDir(),name),file=join(dest,'evidence.json');
    if(deps.verify!==verify&&existsSync(file)){const old=readJson(file) as Evidence;if(old.passed&&same(old.source,manifest(work()))){atomic(join(experimentDir(),name+'.json'),old);return old;}}
    const result=await scoped(signal=>deps.verify(s,root,work(),dest,performance,signal));
    atomic(join(experimentDir(),name+'.json'),result);store.event(s,'verification.completed',result);return result;
  }
  function snapshot(name:string){
    const dest=join(experimentDir(),name);
    if(existsSync(dest)) {
      if(!same(manifest(dest),manifest(work())))throw new Error('归档快照与当前源码不一致');
    }else copySource(work(),dest);
    atomic(join(experimentDir(),name+'-manifest.json'),manifest(dest));
  }
  try {
    if(s.closeout){await finishCloseout(s,store,deps.agent,abort.signal);return;}
    while(true) {
      updateTime();abort.signal.throwIfAborted();
      if(control().action==='stop')interrupt();
      experimentAbort.signal.throwIfAborted();
      if(reached(s.usedSeconds,s.budget.seconds)){deadline=true;throw new Error('总运行时间预算耗尽');}
      if(control().action==='pause'){s.status='paused';break;}
      if(reached(s.calls,s.budget.calls)||reached(s.tokens,s.budget.tokens)){s.status='budget_exhausted';break;}
      if(existsSync(join(root,'trusted-manifest.json'))&&!same(treeManifest(join(root,'trusted')),readJson(join(root,'trusted-manifest.json'))))throw new Error('固定测试源码被修改');
      if(existsSync(join(root,'baseline-manifest.json'))&&!same(manifest(join(root,'baseline')),readJson(join(root,'baseline-manifest.json'))))throw new Error('基线源码被修改');
      store.event(s,'stage.started');
      if(s.stage==='baseline') {
        const dest=join(root,'baseline-evidence');
        let result:Evidence;
        if(existsSync(join(dest,'evidence.json'))&&readJson(join(dest,'evidence.json')).passed&&same(readJson(join(dest,'evidence.json')).source,manifest(join(root,'baseline'))))result=readJson(join(dest,'evidence.json'));
        else result=await scoped(signal=>deps.verify(s,root,join(root,'baseline'),dest,true,signal));
        if(!result.passed)throw new Error('基线验证失败：'+result.error);
        transition('plan');continue;
      }
      mkdirSync(experimentDir(),{recursive:true});
      if(!existsSync(work()))copySource(s.parent,work());
      if(!existsSync(join(experimentDir(),'parent.json')))atomic(join(experimentDir(),'parent.json'),{path:s.parent,source:manifest(s.parent)});
      const unlock=lockWorkspace(work());
      try {
        if(s.stage==='plan') {
          let plan:any;let feedback='';
          for(let correction=0;correction<3;correction++) {
            plan=await model('plan','根据历史结果选择可执行假设，明确 task、稳定 familyId 和模板复用策略。references 仅限 research.sourceRoot 内实际文件；候选或基线分析放 localEvidence/hypothesis/changes。诊断使用已公布 capabilities。'+feedback);
            try {
              validateResearchPlan(root,s,plan);
              if(plan.task==='finalize_family'){if(!s.sanitizerPolicy)throw new Error('算法族最终验证未启用 sanitizer');validateArchivedFinalization(root,s,plan);}
              if(['diagnose','remeasure'].includes(plan.task)&&!plan.diagnostics?.length)throw new Error('诊断任务必须提供 diagnostics');
              recordReferences(s,root,plan);registerFamily(root,s,plan);registerQuestion(root,s,plan);
              break;
            }catch(error) {
              atomic(join(experimentDir(),`plan-invalid-${correction}.json`),{plan,error:String(error)});
              rmSync(join(experimentDir(),'plan.json'),{force:true});rmSync(join(experimentDir(),'plan-source.json'),{force:true});
              if(correction===2)throw error;
              feedback='\n仅修正计划结构，不重新研究；控制器校验错误：'+String(error);
              store.event(s,'plan.correction',{correction:correction+1,error:String(error)});
            }
          }
          atomic(join(experimentDir(),'parent.json'),{path:s.parent,source:manifest(s.parent)});
          transition(plan.task==='finalize_family'?'family_finalize':['diagnose','remeasure'].includes(plan.task)?'diagnose':'develop');
        }else if(s.stage==='family_finalize') {
          const plan=readJson(join(experimentDir(),'plan.json'));validateArchivedFinalization(root,s,plan);
          const result:{passed:boolean;representatives:any[]}={passed:true,representatives:[]};
          for(const rep of plan.finalization.representatives) {
            const source=join(root,'experiments',String(rep.experiment),'archived');
            const dest=join(experimentDir(),'sanitizer','representatives',String(rep.experiment));
            const evidence=await scoped(signal=>(deps.sanitize??sanitize)(s,root,source,dest,signal));
            if(!same(evidence.source,manifest(source)))throw new Error('代表检查与归档源码不匹配');
            atomic(join(experimentDir(),`representative-${rep.experiment}.json`),evidence);
            result.representatives.push({experiment:rep.experiment,status:evidence.status,evidence:join(experimentDir(),`representative-${rep.experiment}.json`)});
            if(evidence.status!=='passed')result.passed=false;
            atomic(join(experimentDir(),'family-validation.json'),result);
            if(evidence.status==='blocked'||evidence.status==='cancelled')throw new Error('代表最终验证环境受阻，可恢复：'+rep.experiment);
          }
          transition('archive_family_decide');
        }else if(s.stage==='archive_family_decide') {
          const plan=readJson(join(experimentDir(),'plan.json')),validation=readJson(join(experimentDir(),'family-validation.json'));
          const decision=await decisionModel('family_decide','本轮仅整理既有算法族与验证其归档代表，没有产生新代码候选。根据 family-validation.json 与代表报告给出 questionOutcome。disposition=archive、parent=current，不再请求 finalize_family；通过后明确结束当前算法族，继续提出算法/布局/融合等结构问题。失败时制定修复或搁置，不得宣称全局完成。移植说明以 plan.finalization.portingGuide 为基础，不要求 sm_120 参数最优。familyAction 明确表示本族关闭或保持开放，与整个任务的 action 独立。',validation.passed);
          if(decision.action==='finalize_family'||decision.disposition!=='archive'||decision.parent!=='current'||(!validation.passed&&decision.stopReason==='goal_converged')) {
            rmSync(join(experimentDir(),'family_decide.json'),{force:true});throw new Error('归档算法族决策无效或验证失败却宣称完成');
          }
          closeFamily(root,plan,{...decision,familyClosure:plan.finalization},validation.passed,s.experiment);
          recordQuestionOutcome(root,s,plan,decision);
          if(!s.results.some(r=>r.experiment===s.experiment))s.results.push({experiment:s.experiment,eligible:false,path:experimentDir(),decision});
          writeExperimentReport(root,s.experiment);writeResearchIndex(root,s);store.event(s,'family.finalized',{familyId:plan.familyId,validation,decision});
          if(decision.action==='stop'&&!(s.timeOnly&&decision.stopReason==='branch_complete')){s.status=decision.stopReason==='environment_blocked'?'blocked':'completed';break;}
          if(reached(s.experiment,s.budget.experiments)){s.status='budget_exhausted';break;}
          s.experiment++;transition('plan');if(decision.action==='pause'){s.status='paused';break;}
        }else if(s.stage==='diagnose') {
          const plan=readJson(join(experimentDir(),'plan.json'));
          const result=await scoped(signal=>(deps.diagnose??diagnose)(s,root,plan,join(experimentDir(),'diagnostics'),signal));
          atomic(join(experimentDir(),'diagnostics.json'),result);transition('diagnostic_decide');
        }else if(s.stage==='diagnostic_decide') {
          const decision=await decisionModel('diagnostic_decide','解释 diagnostics.json 的实际证据。未执行或 unavailable 不能视为通过；没有代码变化不产生新候选。只允许 continue/pause/stop，disposition=archive，parent=current；不要请求 sanitizer，不得宣称算法族或全局已验证。明确下一步可执行任务。');
          if(decision.action==='finalize_family'||decision.disposition!=='archive'||decision.parent!=='current'||decision.stopReason==='goal_converged') {
            rmSync(join(experimentDir(),'diagnostic_decide.json'),{force:true});throw new Error('诊断决策不得提升候选或结束算法族');
          }
          if(!s.results.some(r=>r.experiment===s.experiment))s.results.push({experiment:s.experiment,eligible:false,path:experimentDir(),decision});
          recordQuestionOutcome(root,s,readJson(join(experimentDir(),'plan.json')),decision);
          writeExperimentReport(root,s.experiment);writeResearchIndex(root,s);store.event(s,'diagnostic.completed',{decision});
          if(reached(s.experiment,s.budget.experiments)){s.status='budget_exhausted';break;}
          s.experiment++;transition('plan');
          if(decision.action==='stop'||decision.action==='pause'){s.status=decision.stopReason==='environment_blocked'?'blocked':'paused';break;}

        }else if(s.stage==='develop') {
          await model('develop','按本轮计划实现。测试由控制器执行；不要自行构建测试或生成其他目录。若此前中断，先检查现场再继续。');snapshot('developed');
          if(same(manifest(work()),manifest(s.parent))) {
            atomic(join(experimentDir(),'diagnostics.json'),{status:'no_change',reason:'源码与父方案相同，跳过重复验证；请提出可执行诊断或新实现。'});transition('diagnostic_decide');
          }else transition('check');
        }else if(s.stage==='check') {
          const result=await check('first-check',false);transition(result.passed?'review':'decide');
        }else if(s.stage==='review') {
          const result=await model('review','对实际代码独立审阅算法、架构限制、warp 同步、边界与 API；核对 first-check.json 的控制器测试证据。');
          transition(result.verdict==='passed'?'refactor':'decide');
        }else if(s.stage==='refactor') {
          await model('refactor','基于已验证实现，完成 plan 中分配给 refactorer 的工作，并处理 review 中的可读性/参数说明建议。合理提取模板参数；不要把基线已有的长期限制当作本轮算法改写任务，不改变验收标准。');snapshot('refactored');transition('final_check');
        }else if(s.stage==='final_check') {
          const result=await check('final-check',true);transition(result.passed?'final_review':'decide');
        }else if(s.stage==='final_review') {
          await model('final_review','审查重构是否保持语义、可读性与模板参数约束；核对 final-check.json 的完整正确性与性能证据。性能变慢不等于正确性失败；只报告本机实测，目标平台尚未实测。');transition('decide');
        }else if(s.stage==='sanitizer') {
          snapshot('final-candidate');
          const dest=join(experimentDir(),'sanitizer');let result:SanitizerEvidence;
          try {result=await scoped(signal=>(deps.sanitize??sanitize)(s,root,join(experimentDir(),'final-candidate'),dest,signal));}
          finally {if(existsSync(join(dest,'evidence.json')))atomic(join(experimentDir(),'sanitizer.json'),readJson(join(dest,'evidence.json')));}
          if(!same(result.source,manifest(work())))throw new Error('sanitizer 证据与候选源码不匹配');
          atomic(join(experimentDir(),'sanitizer.json'),result);store.event(s,'sanitizer.completed',result);
          if(result.status==='blocked'||result.status==='cancelled')throw new Error(result.error??'sanitizer 未完成');
          const request=existsSync(join(experimentDir(),'finalize-request.json'))?readJson(join(experimentDir(),'finalize-request.json')):undefined;
          for(const representative of request?.familyClosure?.representatives??[]) {
            if(representative.experiment===s.experiment)continue;
            const source=join(root,'experiments',String(representative.experiment),'archived');
            const evidence=await scoped(signal=>(deps.sanitize??sanitize)(s,root,source,join(dest,'representatives',String(representative.experiment)),signal));
            atomic(join(experimentDir(),`representative-${representative.experiment}.json`),evidence);
            if(evidence.status==='blocked'||evidence.status==='cancelled')throw new Error('算法族代表最终检查受阻：'+representative.experiment+'；'+evidence.status);
          }
          transition('family_decide');
        }else {
          const final=existsSync(join(experimentDir(),'final-check.json'))?readJson(join(experimentDir(),'final-check.json')):undefined;
          const review=existsSync(join(experimentDir(),'final_review.json'))?readJson(join(experimentDir(),'final_review.json')):undefined;
          const numericalEligible=Boolean(final?.passed&&review?.verdict==='passed'&&same(final.source,manifest(work())));
          const sanitizerReport=existsSync(join(experimentDir(),'sanitizer.json'))?readJson(join(experimentDir(),'sanitizer.json')) as SanitizerEvidence:undefined;
          const sanitizerStatus=sanitizerReport?.status??'not_run';
          if(sanitizerReport&&!same(sanitizerReport.source,manifest(work())))throw new Error('sanitizer 源码哈希不匹配');
          const eligible=numericalEligible&&!['failed','blocked','cancelled'].includes(sanitizerStatus);
          const representativeFailure=readdirSync(experimentDir()).filter(f=>/^representative-\d+\.json$/.test(f)).some(f=>readJson(join(experimentDir(),f)).status!=='passed');
          const familyVerificationPassed=numericalEligible&&sanitizerStatus==='passed'&&!representativeFailure&&s.profile==='full';
          const baseline=readJson(join(root,'baseline-evidence/evidence.json')) as Evidence;
          const parentEvidenceFile=join(s.parent,'..','final-check.json');
          const parentEvidence=existsSync(parentEvidenceFile)?readJson(parentEvidenceFile):baseline;
          const comparison=(final?.performance??[]).map((item:any)=>{
            const base=baseline.performance.find(v=>v.nb===item.nb&&v.blocks===item.blocks&&v.uplo===item.uplo&&v.diag===item.diag);
            const parent=parentEvidence.performance?.find((v:any)=>v.nb===item.nb&&v.blocks===item.blocks&&v.uplo===item.uplo&&v.diag===item.diag);
            return {...item,baselineUs:base?.medianUs,speedup:base?base.medianUs/item.medianUs:null,parentUs:parent?.medianUs,parentSpeedup:parent?parent.medianUs/item.medianUs:null};
          });
          atomic(join(experimentDir(),'comparison.json'),{eligible,localValidationPassed:numericalEligible&&s.profile==='full',sanitizerStatus,familyVerificationPassed,comparison,baseline:'sm_120 local only',targetRuntimeVerified:false});
          const decisionKind=s.stage==='family_decide'?'family_decide':'decide';
          const decision=await decisionModel(decisionKind,`基于本轮代码、正确性及性能结果决定继续、暂停或结束。eligible=${eligible}，profile=${s.profile}。只有 eligible 才允许 retain。parent=current 要求数值与审阅通过，sanitizer 检出缺陷时只允许明确继续修复，不能提升为通过方案。较慢但正确的方案可 archive。给出具体下一步假设；下一轮规划将读到该决策。不得突破预算。timeOnly=${Boolean(s.timeOnly)}。单个分支完成用 stopReason=branch_complete；全局收敛才用 goal_converged，环境受阻用 environment_blocked，明确人工停止用 user_requested。sanitizerPolicy=${s.sanitizerPolicy??'disabled'}，sanitizerStatus=${sanitizerStatus}。sanitizerPolicy 启用时，算法族准备结束探索用 action=finalize_family，先请求控制器最终检查；disabled 时沿用旧流程，不请求该动作。family_decide 阶段根据 sanitizer.json 反馈决定继续修复、暂停或结束，不得再次请求 finalize_family。检查失败不得 retain 或宣称 goal_converged；可 archive/reject 并 continue、parent=current 来修复当前候选，或 parent=baseline 另选算法。最终反馈必须给出 familyAction=close/keep_open；action=continue 可以同时关闭当前族并继续全局研究。`,numericalEligible&&sanitizerStatus==='passed'&&!representativeFailure);
          const repair=numericalEligible&&sanitizerStatus==='failed'&&decision.action==='continue'&&decision.disposition!=='retain';
          if(!eligible&&(decision.disposition==='retain'||(decision.parent==='current'&&!repair))){rmSync(join(experimentDir(),decisionKind+'.json'));throw new Error('planner 试图提升未通过验证的候选');}
          if(decisionKind==='family_decide'&&(decision.action==='finalize_family'||((sanitizerStatus!=='passed'||representativeFailure)&&decision.stopReason==='goal_converged'))) {
            rmSync(join(experimentDir(),decisionKind+'.json'));throw new Error('最终检查未通过不能宣称收敛，且不得重复请求同轮最终检查');
          }
          const plan=existsSync(join(experimentDir(),'plan.json'))?readJson(join(experimentDir(),'plan.json')):undefined;
          const finishRequested=decision.action==='finalize_family'||(decision.action==='stop'&&decision.stopReason==='goal_converged');
          if(decisionKind==='decide'&&finishRequested&&s.sanitizerPolicy&&numericalEligible) {
            try{validateClosure(root,s,plan,decision);}catch(error){rmSync(join(experimentDir(),decisionKind+'.json'),{force:true});throw error;}
            atomic(join(experimentDir(),'finalize-request.json'),decision);snapshot('final-candidate');transition('sanitizer');continue;
          }
          if(decision.action==='finalize_family'){rmSync(join(experimentDir(),decisionKind+'.json'));throw new Error('只有通过数值与审阅且启用 sanitizer 的候选可请求算法族最终验证');}
          snapshot('archived');
          if(decisionKind==='family_decide') {
            const request=readJson(join(experimentDir(),'finalize-request.json'));
            closeFamily(root,plan,{...decision,familyClosure:request.familyClosure},numericalEligible&&sanitizerStatus==='passed'&&!representativeFailure,s.experiment);
          }
          if(!s.results.some(r=>r.experiment===s.experiment))s.results.push({experiment:s.experiment,eligible,path:experimentDir(),decision});
          recordQuestionOutcome(root,s,readJson(join(experimentDir(),'plan.json')),decision);
          writeExperimentReport(root,s.experiment);writeResearchIndex(root,s);
          store.event(s,'experiment.archived',{eligible,decision});
          s.parent=decision.parent==='current'?join(experimentDir(),'archived'):join(root,'baseline');
          if(decision.action==='stop'&&!(s.timeOnly&&decision.stopReason==='branch_complete')){s.status=decision.stopReason==='environment_blocked'?'blocked':'completed';break;}
          if(reached(s.experiment,s.budget.experiments)){s.status='budget_exhausted';break;}
          s.experiment++;transition('plan');
          if(decision.action==='pause'){s.status='paused';break;}
        }
      } finally {unlock();}
    }
  }catch(error){
    s.error=String(error);
    if((deadline||requestedStop)&&!s.closeout) {
      experimentEndedAt=Date.now();
      try{await finishCloseout(s,store,deps.agent,abort.signal,requestedStop?'user_stop':'time_limit');}
      catch(closeoutError){s.error=String(closeoutError);s.status='blocked';store.event(s,'closeout.failed',{error:s.error});}
    }else if(error instanceof PauseRequested){s.status='paused';delete s.error;
    }else {
      s.status=String(error).includes('MODEL_BUDGET')?'budget_exhausted':'blocked';
      store.event(s,'interrupted',{error:s.error,status:s.status});
    }
  }finally{
    clearInterval(heartbeat);process.off('SIGTERM',interrupt);process.off('SIGINT',interrupt);
    updateTime();delete s.workerPid;store.save(s);store.event(s,'worker.finished',{status:s.status});release();
  }
}
