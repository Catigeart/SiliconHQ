import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifySanitizer,sanitizerMarkers } from '../dist/kernel/sanitizer.js';
test('sanitizer requires completed workloads and clean tool summary, not just exit 0',()=>{
 const rows=sanitizerMarkers(32).join('\n');
 assert.equal(classifySanitizer('sanitizer workload produced non-finite output','memcheck',32,true),'failed');
 assert.equal(sanitizerMarkers(32).length,6);assert.equal(sanitizerMarkers(1024).length,3);
 for(const tool of ['memcheck','initcheck','synccheck']) {
  const clean=rows+'\n========= ERROR SUMMARY: 0 errors';
  assert.equal(classifySanitizer(clean,tool,32),'passed');
  assert.equal(classifySanitizer(clean,tool,32,true),'blocked');
  assert.equal(classifySanitizer(clean+'\nFailed to initialize WDDM debugger interface',tool,32),'blocked');
  assert.equal(classifySanitizer('ERROR SUMMARY: 0 errors',tool,32),'blocked');
  assert.equal(classifySanitizer('ERROR SUMMARY: 2 errors',tool,32,true),'failed');
 }
 assert.equal(classifySanitizer(rows+'\nRACECHECK SUMMARY: 0 hazards displayed (0 errors, 0 warnings)','racecheck',32),'passed');
 assert.equal(classifySanitizer('RACECHECK SUMMARY: 1 hazard displayed (0 errors, 1 warnings)','racecheck',32),'failed');
});
