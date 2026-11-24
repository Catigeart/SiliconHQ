import { developerFeedbackRole, plannerSummaryRole } from './closeout.js';
import { developerRole } from './developer.js';
import { plannerRole } from './planner.js';
import { reviewerRole, blockingReviewerRole, type ReviewPolicy } from './reviewer.js';
import type { RoleDefinition, RoleName, RunPurpose } from './types.js';

export const roles: Record<RoleName, RoleDefinition> = {
  planner: plannerRole,
  developer: developerRole,
  reviewer: reviewerRole,
};

export function getRoleDefinition(
  role: RoleName,
  purpose?: RunPurpose,
  policy?: ReviewPolicy,
): RoleDefinition {
  if (!purpose && role === 'reviewer' && policy === 'blocking') return blockingReviewerRole;
  if (!purpose) return roles[role];
  if (role === 'developer' && purpose === 'developer_feedback') return developerFeedbackRole;
  if (role === 'planner' && purpose === 'planner_summary') return plannerSummaryRole;
  throw new Error('角色与任务用途不匹配');
}
