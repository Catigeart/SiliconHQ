import { speedSchema } from './speed.js';
import { z } from 'zod';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RoleName } from '../roles/types.js';

// 对应已安装 Codex SDK 的 ModelReasoningEffort；具体模型仍需支持所选档位。
export const reasoningEffortSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'persistent']);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
const roleConfigSchema = z.strictObject({
  speed: speedSchema.default('inherit'),
  model: z.string().trim().min(1),
  reasoningEffort: reasoningEffortSchema.default('medium'),
});
export type RoleConfig = z.infer<typeof roleConfigSchema>;
export const rolesConfigSchema = z.strictObject({
  roles: z.strictObject({
    planner: roleConfigSchema,
    developer: roleConfigSchema,
    reviewer: roleConfigSchema,
  }),
});

export function loadRoleConfig(cwd: string, role: RoleName): RoleConfig {
  const local = join(cwd, 'llm-coder.config.json');
  const path = existsSync(local) ? local : fileURLToPath(new URL('../../llm-coder.config.json', import.meta.url));
  try {
    return rolesConfigSchema.parse(JSON.parse(readFileSync(path, 'utf8'))).roles[role];
  } catch (error) {
    throw new Error(`角色配置无效：${path}；${error instanceof Error ? error.message : String(error)}`);
  }
}
