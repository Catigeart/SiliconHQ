import { join } from 'node:path';
import { validateArchivedFinalization } from '../families.js';
import { sanitize } from '../sanitizer.js';
import { atomic, manifest, readJson } from '../store.js';

import { same } from '../runtime-types.js';
import type { StageContext, StageResult } from '../stage-context.js';
export async function handleFamilyFinalize(context: StageContext): Promise<StageResult> {
  const { s, root, deps, scoped, experimentDir, transition } = context;

  const plan = readJson(join(experimentDir(), 'plan.json'));
  validateArchivedFinalization(root, s, plan);
  const result: { passed: boolean; representatives: any[] } = { passed: true, representatives: [] };
  for (const rep of plan.finalization.representatives) {
    const source = join(root, 'experiments', String(rep.experiment), 'archived');
    const dest = join(experimentDir(), 'sanitizer', 'representatives', String(rep.experiment));
    const evidence = await scoped((signal) =>
      (deps.sanitize ?? sanitize)(s, root, source, dest, signal),
    );
    if (!same(evidence.source, manifest(source))) throw new Error('代表检查与归档源码不匹配');
    atomic(join(experimentDir(), `representative-${rep.experiment}.json`), evidence);
    result.representatives.push({
      experiment: rep.experiment,
      status: evidence.status,
      evidence: join(experimentDir(), `representative-${rep.experiment}.json`),
    });
    if (evidence.status !== 'passed') result.passed = false;
    atomic(join(experimentDir(), 'family-validation.json'), result);
    if (evidence.status === 'blocked' || evidence.status === 'cancelled')
      throw new Error('代表最终验证环境受阻，可恢复：' + rep.experiment);
  }
  transition('archive_family_decide');
}
