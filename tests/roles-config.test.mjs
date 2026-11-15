import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRoleConfig, rolesConfigSchema } from '../dist/config/roles.js';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
test('local role configuration overrides defaults and rejects invalid config', () => {
  const dir = mkdtempSync(join(tmpdir(), 'llm-roles-'));
  try {
    assert.equal(loadRoleConfig(dir, 'planner').model, 'gpt-6-astra');
    const roles = { planner: {model:'custom'}, developer:{model:'dev'}, reviewer:{model:'review'} };
    writeFileSync(join(dir,'llm-coder.config.json'), JSON.stringify({roles}));
    assert.equal(loadRoleConfig(dir, 'planner').model, 'custom');
    writeFileSync(join(dir,'llm-coder.config.json'), '{}');
    assert.throws(() => loadRoleConfig(dir, 'planner').model);
  } finally { rmSync(dir,{recursive:true,force:true}); }
});

test('old model-only configuration has explicit medium defaults', () => {
  const config = rolesConfigSchema.parse({ roles: {
    planner: { model: 'p' }, developer: { model: 'd' }, reviewer: { model: 'r' },
  } });
  for (const role of Object.values(config.roles)) assert.equal(role.reasoningEffort, 'medium');
});
test('reject unsupported effort spelling and unknown configuration keys', () => {
  const config = { roles: {
    planner: { model: 'p', reasoningEffort: 'high' }, developer: { model: 'd' }, reviewer: { model: 'r' },
  } };
  assert.equal(rolesConfigSchema.parse(config).roles.planner.reasoningEffort, 'high');
  config.roles.planner.reasoningEffort = 'extreme';
  assert.equal(rolesConfigSchema.safeParse(config).success, false);
  config.roles.planner = { model: 'p', reasoning_effort: 'high' };
  assert.equal(rolesConfigSchema.safeParse(config).success, false);
});

test('speed defaults to inherit and validates each supported value',()=>{
 const roles={planner:{model:'p'},developer:{model:'d'},reviewer:{model:'r'}};
 assert.equal(rolesConfigSchema.parse({roles}).roles.planner.speed,'inherit');
 for(const speed of ['inherit','standard','fast']) {roles.planner.speed=speed;assert.equal(rolesConfigSchema.parse({roles}).roles.planner.speed,speed);}
 roles.planner.speed='turbo';assert.equal(rolesConfigSchema.safeParse({roles}).success,false);
});
