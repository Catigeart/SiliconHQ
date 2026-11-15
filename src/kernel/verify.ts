import { evidenceKey, environmentIdentity, loadEvidence, saveEvidence } from './evidence-cache.js';
import { digest } from './build.js';
import { buildFrozen } from './build.js';
import { sampling, ncuExecutable, ncuArguments, ncuSamples } from './performance.js';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { command } from './process.js';
import { atomic, manifest, treeManifest, readJson, type State } from './store.js';
import { lockWorkspace } from '../storage/workspace-lock.js';

export type Evidence = {correctnessReuse?:{path:string;key:string};passed:boolean; source:Record<string,string>; architectures:number[]; sizes:number[]; profile:string; performance:{nb:number;blocks:number;uplo:number;diag:number;samples:number[];medianUs:number; timingMethod?:string; clockControl?:string; iterations?:number}[]; log:string; compatibility?:{reused:boolean;path:string;reason:string}; correctnessLogs?:string[]; error?:string; targetRuntimeVerified:false};
export async function verify(s:State,root:string,source:string,dest:string,performance:boolean,signal:AbortSignal):Promise<Evidence> {
  mkdirSync(dest,{recursive:true});const log=join(dest,'commands.log');
  const evidence:Evidence={passed:false,source:manifest(source),architectures:[],sizes:s.sizes,profile:s.profile,performance:[],log,targetRuntimeVerified:false};
  // Serialize this controller's GPU tests across campaigns, without suspending unrelated processes.
  const gpuLockDir=join(root,'..','gpu-lock');mkdirSync(gpuLockDir,{recursive:true});
  const unlock=lockWorkspace(gpuLockDir);
  let phase='configure';
  try {
    const trusted=join(root,'trusted');
    const trustedHash=readJson(join(root,'trusted-manifest.json'));
    if(JSON.stringify(treeManifest(trusted))!==JSON.stringify(trustedHash))throw new Error('固定测试源码被修改');
    const executable=await buildFrozen(source,trusted,dest,log,signal,()=>{phase='build';});
    const binaryHash=digest(readFileSync(executable));
    evidence.architectures=[80,90,120];phase='test';
    evidence.correctnessLogs=[];
    phase='environment';
    const key=evidenceKey({kind:'correctness-v2',source:evidence.source,trustedHash,binary:binaryHash,environment:environmentIdentity(),sizes:s.sizes,profile:s.profile,policy:s.testPolicy,verifier:digest(readFileSync(new URL('./verify.js',import.meta.url)))});
    const cached=loadEvidence(root,key);phase='test';
    const split=s.testPolicy==='split-v1'||s.testPolicy==='split-gpu-v2';
    if(cached) {
      evidence.correctnessLogs=cached.evidence.correctnessLogs;
      evidence.compatibility=cached.evidence.compatibility;
      if(evidence.compatibility)evidence.compatibility={...evidence.compatibility,reused:true};
      evidence.correctnessReuse={key,path:cached.evidence.path};
    }else {
      for(const nb of s.sizes) {
        const file=join(dest,`check-${nb}.log`);writeFileSync(file,'');
        evidence.correctnessLogs.push(file);
        await command([executable,split?'core':'check',String(nb)],dest,file,signal);
        const rows=readFileSync(file,'utf8').split('\n').filter(row=>row.startsWith('CHECK,'));
        const expected=new Set<string>();
        for(const u of (split?[0]:[0,1]))for(const d of (split?[0]:[0,1]))for(const [blocks,tail,family] of [[1,0,0],[2,0,1],[1,13,2],[0,17,3]])expected.add(`CHECK,${nb},${blocks},${tail},${u},${d},${family},PASS`);
        if(rows.length!==expected.size||new Set(rows).size!==expected.size||rows.some(row=>!expected.has(row)))throw new Error('正确性测试结果缺项或无效：'+file);
      }
      if(split) {
          const file=join(dest,'compat-32.log');writeFileSync(file,'');
          await command([executable,'compat','32'],dest,file,signal);
          const rows=readFileSync(file,'utf8').split('\n').filter(row=>row.startsWith('CHECK,'));
          const expected=['CHECK,32,1,13,0,1,2,PASS','CHECK,32,1,13,1,0,2,PASS','CHECK,32,1,13,1,1,2,PASS'];
          if(JSON.stringify([...rows].sort())!==JSON.stringify(expected.sort()))throw new Error('兼容集结果不完整');
          evidence.compatibility={reused:false,path:file,reason:'首次执行或源码变化，保守重跑三项兼容检查'};
  
      }
      if(JSON.stringify(manifest(source))!==JSON.stringify(evidence.source)||JSON.stringify(treeManifest(trusted))!==JSON.stringify(trustedHash)||digest(readFileSync(executable))!==binaryHash)throw new Error('正确性检查期间输入变化');
      const correctnessFile=join(dest,'correctness-evidence.json');
      atomic(correctnessFile,{passed:true,source:evidence.source,sizes:s.sizes,profile:s.profile,correctnessLogs:evidence.correctnessLogs,compatibility:evidence.compatibility,key});
      saveEvidence(root,key,{correctnessLogs:evidence.correctnessLogs,compatibility:evidence.compatibility,path:correctnessFile},[...(evidence.correctnessLogs??[]),...(evidence.compatibility?[evidence.compatibility.path]:[])]);
    }
    if(performance&&(s.performancePolicy==='ncu-base-v1'||s.performancePolicy==='ncu-base-pitched-v2')) {
      phase='profiling';
      const ncu=ncuExecutable();
      for(const nb of s.sizes) {
        const policy=sampling(nb),file=join(dest,`bench-${nb}-4.log`),report=join(dest,`ncu-${nb}-4.csv`);
        writeFileSync(file,'');writeFileSync(report,'');
        await command([ncu,...ncuArguments(executable,nb,report)],dest,file,signal);
        const output=readFileSync(file,'utf8');
        if(/==ERROR==|==WARNING==/.test(output))throw new Error(output.slice(-2000));
        const markers=output.split('\n').filter(line=>line.startsWith('PROFILE,'));
        const expected=Array.from({length:policy.groups},(_,i)=>`PROFILE,${nb},4,${i},${policy.iterations}`);
        if(JSON.stringify(markers)!==JSON.stringify(expected))throw new Error('NCU 测量轮次不完整');
        const samples=ncuSamples(readFileSync(report,'utf8'),policy.groups,policy.iterations);
        evidence.performance.push({nb,blocks:4,uplo:0,diag:0,samples,medianUs:[...samples].sort((a,b)=>a-b)[Math.floor(samples.length/2)]!,
          timingMethod:'ncu-range-gpu-duration',clockControl:'base',iterations:policy.iterations});
      }
    }else if(performance)for(const nb of s.sizes)for(const blocks of s.blocks) {
      const file=join(dest,`bench-${nb}-${blocks}.log`);
      // Truncate on retries: never combine measurements from interrupted attempts.
      writeFileSync(file,'');
      await command([executable,split?'bench-core':'bench',String(nb),String(blocks),String(s.iterations)],dest,file,signal);
      const rows=readFileSync(file,'utf8').split('\n').filter(row=>row.startsWith('BENCH,')).map(row=>row.split(',').map(Number));
      for(const uplo of (split?[0]:[0,1]))for(const diag of (split?[0]:[0,1])) {
        const samples=rows.filter(r=>r[3]===uplo&&r[4]===diag).map(r=>r[6]!);
        if(samples.length!==5||samples.some(v=>!Number.isFinite(v)||v<=0))throw new Error('性能样本不完整或无效');
        evidence.performance.push({nb,blocks,uplo,diag,samples,medianUs:[...samples].sort((a,b)=>a-b)[2]!});
      }
    }
    if(JSON.stringify(manifest(source))!==JSON.stringify(evidence.source))throw new Error('测量过程中源码变化');
    if(JSON.stringify(treeManifest(trusted))!==JSON.stringify(trustedHash))throw new Error('测试期间验证器被修改');
    if(digest(readFileSync(executable))!==binaryHash)throw new Error('验证期间二进制变化');
    evidence.passed=true;
  }catch(error){evidence.error=String(error);if(signal.aborted)throw error;
    if(phase==='configure'||phase==='profiling'||phase==='environment'||/ENOSPC|ENOENT|No space left|no CUDA-capable|CUDA driver version|initialization error|out of memory/i.test(String(error)))throw new Error('验证环境受阻：'+String(error));}
  finally{atomic(join(dest,'evidence.json'),evidence);unlock();}
  return evidence;
}
