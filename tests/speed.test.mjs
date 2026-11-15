import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSpeedArgs, parseSpeedText, speedConfig } from '../dist/config/speed.js';
test('speed overrides distinguish inheritance from an explicit standard request',()=>{
 assert.equal(speedConfig(),undefined);assert.equal(speedConfig('inherit'),undefined);
 assert.deepEqual(speedConfig('fast'),{service_tier:'fast',features:{fast_mode:true}});
 assert.deepEqual(speedConfig('standard'),{service_tier:'default',features:{fast_mode:false}});
});
test('speed flags reject conflicts and preserve literal requirement text',()=>{
 assert.deepEqual(parseSpeedArgs(['workflow','task','--fast']),{args:['workflow','task'],speed:'fast'});
 assert.throws(()=>parseSpeedArgs(['--fast','--no-fast']),/不能同时/);
 assert.deepEqual(parseSpeedArgs(['plan','--','--fast']),{args:['plan','--fast'],speed:undefined});
 assert.deepEqual(parseSpeedText('--no-fast implement --fast option'),{text:'implement --fast option',speed:'standard'});
 assert.deepEqual(parseSpeedText('-- --fast'),{text:'--fast',speed:undefined});
});
