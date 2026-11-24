import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { sanitize, type SanitizerEvidence } from '../sanitizer.js';
import { atomic, manifest, readJson } from '../store.js';

import { same } from '../runtime-types.js';
import type { StageContext, StageResult } from '../stage-context.js';
export async function handleSanitizer(context: StageContext): Promise<StageResult> {
  const { s, store, root, deps, scoped, experimentDir, work, transition, snapshot } = context;

  snapshot('final-candidate');
  const dest = join(experimentDir(), 'sanitizer');
  let result: SanitizerEvidence;
  try {
    result = await scoped((signal) =>
      (deps.sanitize ?? sanitize)(s, root, join(experimentDir(), 'final-candidate'), dest, signal),
    );
  } finally {
    if (existsSync(join(dest, 'evidence.json')))
      atomic(join(experimentDir(), 'sanitizer.json'), readJson(join(dest, 'evidence.json')));
  }
  if (!same(result.source, manifest(work()))) throw new Error('sanitizer 证据与候选源码不匹配');
  atomic(join(experimentDir(), 'sanitizer.json'), result);
  store.event(s, 'sanitizer.completed', result);
  if (result.status === 'blocked' || result.status === 'cancelled')
    throw new Error(result.error ?? 'sanitizer 未完成');
  const request = existsSync(join(experimentDir(), 'finalize-request.json'))
    ? readJson(join(experimentDir(), 'finalize-request.json'))
    : undefined;
  for (const representative of request?.familyClosure?.representatives ?? []) {
    if (representative.experiment === s.experiment) continue;
    const source = join(root, 'experiments', String(representative.experiment), 'archived');
    const evidence = await scoped((signal) =>
      (deps.sanitize ?? sanitize)(
        s,
        root,
        source,
        join(dest, 'representatives', String(representative.experiment)),
        signal,
      ),
    );
    atomic(join(experimentDir(), `representative-${representative.experiment}.json`), evidence);
    if (evidence.status === 'blocked' || evidence.status === 'cancelled')
      throw new Error(
        '算法族代表最终检查受阻：' + representative.experiment + '；' + evidence.status,
      );
  }
  transition('family_decide');
}
