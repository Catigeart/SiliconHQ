import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';

export function sampling(nb:number) {return {blocks:4,groups:nb>=256?1:3,iterations:nb>=256?10:20};}
export function ncuExecutable():string {
  const candidates=[...(process.env.PATH??'').split(delimiter).map(dir=>join(dir,'ncu')),
    '/opt/nvidia/nsight-compute/2025.4.1/ncu','/usr/lib/nsight-compute/2025.4.1/ncu','/usr/local/cuda-13.1/nsight-compute-2025.4.1/ncu'];
  const executable=candidates.find(path=>existsSync(path));
  if(!executable)throw new Error('验证环境受阻：找不到 Nsight Compute ncu，不能执行 base 时钟性能测试');
  return executable;
}
export function ncuArguments(executable:string,nb:number,log:string):string[] {
  const {blocks,groups,iterations}=sampling(nb);
  return ['--clock-control','base','--cache-control','all','--replay-mode','range',
    '--metrics','gpu__time_duration.sum','--csv','--print-units','base',
    '--log-file',log,executable,'bench-ncu',String(nb),String(blocks),String(iterations),String(groups)];
}
export function csv(line:string):string[] {
  const out:string[]=[];let field='',quoted=false;
  for(let i=0;i<line.length;i++) {const ch=line[i];
    if(ch==='"') {if(quoted&&line[i+1]==='"'){field+='"';i++;}else quoted=!quoted;}
    else if(ch===','&&!quoted){out.push(field);field='';}else field+=ch;
  }
  out.push(field);return out;
}
// Only NCU's range metric is accepted. Application CUDA-event/wall timings
// include profiler overhead and must never enter a baseline comparison.
export function ncuSamples(report:string,groups:number,iterations:number):number[] {
  if(/==ERROR==|==WARNING==/i.test(report))throw new Error('NCU 报告包含错误或警告，无法确认有效的 base 测量：'+report.slice(-2000));
  let header:string[]=[];const samples:number[]=[];
  for(const line of report.split(/\r?\n/)) {
    const row=csv(line);
    if(row.includes('Metric Name')&&row.includes('Metric Value')){header=row;continue;}
    if(!header.length||row[header.indexOf('Metric Name')]!=='gpu__time_duration.sum')continue;
    const unit=row[header.indexOf('Metric Unit')];
    const scale:Record<string,number>={nsecond:0.001,usecond:1,msecond:1000,second:1000000,ns:0.001,us:1,ms:1000,s:1000000};
    const value=Number(row[header.indexOf('Metric Value')]?.replaceAll(',',''));
    if(!unit||scale[unit]===undefined||!Number.isFinite(value)||value<=0)throw new Error('NCU 时间指标单位或数值无效');
    samples.push(value*scale[unit]!/iterations);
  }
  if(samples.length!==groups)throw new Error(`NCU range 样本不完整：预期 ${groups}，实际 ${samples.length}`);
  return samples;
}
