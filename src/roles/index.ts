import { developerFeedbackRole, plannerSummaryRole } from './closeout.js';
import { plannerRole } from './planner.js';
import { developerRole } from './developer.js';
import { reviewerRole } from './reviewer.js';
import type { RoleDefinition, RoleName, RunPurpose } from './types.js';

export const roles: Record<RoleName, RoleDefinition> = {
  planner: plannerRole,
  developer: developerRole,
  reviewer: reviewerRole,
};

export function getRoleDefinition(role: RoleName, purpose?: RunPurpose): RoleDefinition {
  if (!purpose) return roles[role];
  if (role === 'developer' && purpose === 'developer_feedback') return developerFeedbackRole;
  if (role === 'planner' && purpose === 'planner_summary') return plannerSummaryRole;
  throw new Error('角色与任务用途不匹配');
}
