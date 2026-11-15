import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampling, ncuArguments, ncuSamples } from '../dist/kernel/performance.js';
test('kernel performance uses four blocks and size-specific sample counts',()=>{
 for(const nb of [32,64,128])assert.deepEqual(sampling(nb),{blocks:4,groups:3,iterations:20});
 for(const nb of [256,512,1024])assert.deepEqual(sampling(nb),{blocks:4,groups:1,iterations:10});
 const argv=ncuArguments('/test/diagonal',512,'/test/report.csv');
 assert.deepEqual(argv.slice(-6),['/test/diagonal','bench-ncu','512','4','10','1']);
 assert.equal(argv[argv.indexOf('--clock-control')+1],'base');
 assert.equal(argv[argv.indexOf('--replay-mode')+1],'range');
});
test('NCU range durations normalize units and iterations without using app event timing',()=>{
 const header='"ID","Kernel Name","Metric Name","Metric Unit","Metric Value"\n';
 assert.deepEqual(ncuSamples(header+'"0","Range, 0","gpu__time_duration.sum","nsecond","20,000"',1,10),[2]);
 const rows=[1,2,3].map(i=>`"${i}","range","gpu__time_duration.sum","usecond","${i*20}"`).join('\n');
 assert.deepEqual(ncuSamples(header+rows,3,20),[1,2,3]);
 for(const text of ['BENCH,32,4,0,0,0,1,2','==WARNING== Failed to lock clocks',header+'"0","range","gpu__time_duration.sum","unknown","1"',header+'"0","range","gpu__time_duration.sum","nsecond","nan"'])assert.throws(()=>ncuSamples(text,1,10));
 assert.throws(()=>ncuSamples(header+rows,1,10),/不完整/);
});
