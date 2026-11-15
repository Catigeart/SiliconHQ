import { join } from 'node:path';
import { diagnose } from '../diagnostics.js';
import { atomic, readJson } from '../store.js';

import type { StageContext, StageResult } from '../stage-context.js';
export async function handleDiagnose(context: StageContext): Promise<StageResult> {
  const { s, root, deps, scoped, experimentDir, transition } = context;

  const plan = readJson(join(experimentDir(), 'plan.json'));
  const result = await scoped((signal) =>
    (deps.diagnose ?? diagnose)(s, root, plan, join(experimentDir(), 'diagnostics'), signal),
  );
  atomic(join(experimentDir(), 'diagnostics.json'), result);
  transition('diagnostic_decide');
}
