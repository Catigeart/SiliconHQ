import { mkdirSync, readFileSync, writeFileSync, renameSync, appendFileSync, readdirSync, lstatSync, cpSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';
import { homedir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';
import { RunStore } from '../storage/runs.js';
import { z } from 'zod';
import { rolesConfigSchema } from '../config/roles.js';

export const budgetSchema = z.object({
  attempts: z.number().int().min(1).nullable().default(2),
  experiments: z.number().int().min(1).max(100).nullable().default(2),
  seconds: z.number().int().min(10).max(604800).nullable().default(3600),
  calls: z.number().int().min(1).max(1000).nullable().default(16),
  stageSeconds: z.number().int().min(1).max(86400).nullable().default(600),
  tokens: z.number().int().min(1).max(100000000).nullable().default(1000000),
});
export type Budget = z.infer<typeof budgetSchema>;
export type Stage = 'baseline'|'plan'|'diagnose'|'diagnostic_decide'|'develop'|'check'|'review'|'refactor'|'final_check'|'final_review'|'decide'|'sanitizer'|'family_decide'|'family_finalize'|'archive_family_decide'|'closeout';
export type State = {
  researchMode?:'algorithm-exploration'|'platform-tuning';researchPolicyStart?:number;
  networkRetry?:{windowSeconds:number;maxDelaySeconds:number};
  networkFailures?:Record<string,{count:number;startedAt:number;lastError:string}>;
  sanitizerPolicy?:'family-final-v1';
  performancePolicy?:'ncu-base-v1'|'ncu-base-pitched-v2'; timeOnly?:boolean; references?:{guide:string;root:string}; testPolicy?:'split-v1'|'split-gpu-v2';
  closeout?:{status:'pending'|'running'|'failed'|'completed';stage:Stage;experiment:number;reason:'time_limit'|'user_stop';seconds:number;attempts:number;error?:string};
  objective?:string; id:string; project:string; createdAt:string; updatedAt:string;
  status:'closing'|'ready'|'running'|'paused'|'stopped'|'blocked'|'budget_exhausted'|'completed';
  stage:Stage; experiment:number; budget:Budget; usedSeconds:number; calls:number; tokens:number;
  profile:'smoke'|'full'; sizes:number[]; blocks:number[]; iterations:number;
  roles:z.infer<typeof rolesConfigSchema>['roles'];
  workerPid?:number; heartbeat?:string; error?:string; parent:string;
  threads:Record<string,string>; attempts:Record<string,number>;
  results:{status?:'completed'|'cancelled';experiment:number; eligible:boolean; path:string; decision?:unknown}[];
};
export function atomic(path:string,value:unknown) {
  const tmp=path+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});renameSync(tmp,path);
}
export class KernelStore {
  constructor(readonly root=join(homedir(),'.llm-coder','kernel')){mkdirSync(root,{recursive:true,mode:0o700});}
  dir(id:string){if(!/^[a-f0-9-]{36}$/.test(id))throw new Error('无效的 kernel-id');return join(this.root,id);}
  read(id:string):State{return JSON.parse(readFileSync(join(this.dir(id),'state.json'),'utf8'));}
  save(s:State){s.updatedAt=new Date().toISOString();atomic(join(this.dir(s.id),'state.json'),s);}
  event(s:State,type:string,data:unknown={}){appendFileSync(join(this.dir(s.id),'events.jsonl'),JSON.stringify({at:new Date().toISOString(),type,stage:s.stage,experiment:s.experiment,data})+'\n');}
  lock(id:string){return new RunStore(this.root).lock(id);}
  list(){return readdirSync(this.root).filter(id=>/^[a-f0-9-]{36}$/.test(id)&&existsSync(join(this.dir(id),'state.json'))).map(id=>this.read(id));}
}
// Source-only copies: reject symlinks and special files, never follow paths outside the candidate.
export function treeManifest(root:string, parts:string[]=[]):Record<string,string> {
  const out:Record<string,string>={};
  const walk=(dir:string)=>{if(lstatSync(dir).isSymbolicLink())throw new Error('目录不允许符号链接：'+dir);for(const entry of readdirSync(dir).sort()) {
    const path=join(dir,entry),stat=lstatSync(path);
    if(stat.isSymbolicLink())throw new Error('源码不允许符号链接：'+path);
    if(stat.isDirectory())walk(path);
    else if(stat.isFile())out[relative(root,path)]=createHash('sha256').update(readFileSync(path)).digest('hex');
    else throw new Error('源码包含特殊文件：'+path);
  }};
  if(parts.length)for(const part of parts)walk(join(root,part));else walk(root);return out;
}
export function manifest(root:string){return treeManifest(root,['src','include']);}
export function copySource(from:string,to:string) {
  manifest(from);const dest=to;to=dest+'.'+randomUUID()+'.tmp';mkdirSync(to,{recursive:true});
  for(const part of ['src','include'])cpSync(join(from,part),join(to,part),{recursive:true,errorOnExist:true,force:false});
  if(existsSync(join(from,'README.txt')))cpSync(join(from,'README.txt'),join(to,'README.txt'));
  renameSync(to,dest);
}
export function readJson(path:string):any{return JSON.parse(readFileSync(path,'utf8'));}
