import type { StageContext, StageResult } from '../stage-context.js';
import type { Stage } from '../store.js';
import { handleArchiveFamilyDecide } from './archive_family_decide.js';
import { handleCheck } from './check.js';
import { handleDecide } from './decide.js';
import { handleDevelop } from './develop.js';
import { handleDiagnose } from './diagnose.js';
import { handleDiagnosticDecide } from './diagnostic_decide.js';
import { handleFamilyFinalize } from './family_finalize.js';
import { handleFinalCheck } from './final_check.js';
import { handleFinalReview } from './final_review.js';
import { handlePlan } from './plan.js';
import { handleRefactor } from './refactor.js';
import { handleReview } from './review.js';
import { handleSanitizer } from './sanitizer.js';
const handlers: Partial<Record<Stage, (context: StageContext) => Promise<StageResult>>> = {
  plan: handlePlan,
  family_finalize: handleFamilyFinalize,
  archive_family_decide: handleArchiveFamilyDecide,
  diagnose: handleDiagnose,
  diagnostic_decide: handleDiagnosticDecide,
  develop: handleDevelop,
  check: handleCheck,
  review: handleReview,
  refactor: handleRefactor,
  final_check: handleFinalCheck,
  final_review: handleFinalReview,
  sanitizer: handleSanitizer,
  decide: handleDecide,
  family_decide: handleDecide,
};
export function executeStage(context: StageContext) {
  const handler = handlers[context.s.stage];
  if (!handler) throw new Error('不支持的实验阶段：' + context.s.stage);
  return handler(context);
}
