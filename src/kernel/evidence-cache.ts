import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { digest } from './build.js';
import { atomic, readJson } from './store.js';
export function environmentIdentity() {
  return {gpu:execFileSync('nvidia-smi',['--query-gpu=uuid,name,driver_version','--format=csv,noheader'],{encoding:'utf8',timeout:10000}),visible:process.env.CUDA_VISIBLE_DEVICES??'',deviceOrder:process.env.CUDA_DEVICE_ORDER??''};
}
export function evidenceKey(inputs:unknown){return digest(JSON.stringify(inputs));}
export function loadEvidence(root:string,key:string):any|undefined {
  const file=join(root,'evidence-cache',key+'.json');if(!existsSync(file))return;
  let entry;try{entry=readJson(file);}catch{return;}
  if(!entry.logs||!Object.keys(entry.logs).length)return;
  for(const [path,hash] of Object.entries(entry.logs))if(!existsSync(path)||digest(readFileSync(path))!==hash)return;
  return entry;
}
export function saveEvidence(root:string,key:string,evidence:unknown,paths:string[]) {
  if(!paths.length)return;
  const logs=Object.fromEntries([...new Set(paths)].map(path=>[path,digest(readFileSync(path))]));
  mkdirSync(join(root,'evidence-cache'),{recursive:true});atomic(join(root,'evidence-cache',key+'.json'),{evidence,logs});
}
