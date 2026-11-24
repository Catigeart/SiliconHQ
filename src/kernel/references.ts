import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { atomic, readJson, type State } from './store.js';

export function recordReferences(s: State, root: string, plan: any) {
  if (!s.references || !Array.isArray(plan.references)) return;
  const library = realpathSync(s.references.root);
  for (const ref of plan.references) {
    const path = realpathSync(ref.path),
      rel = relative(library, path);
    if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel))
      throw new Error('参考文件必须位于指定 references 目录：' + path);
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    if (hash !== ref.sha256) throw new Error('参考文件哈希不匹配：' + path);
  }
  const file = join(root, 'research-notes.json');
  const entries = existsSync(file) ? readJson(file) : [];
  const existing = entries.findIndex((e: any) => e.experiment === s.experiment);
  if (existing >= 0) entries.splice(existing, 1);
  entries.push({
    experiment: s.experiment,
    algorithmFamily: plan.algorithmFamily,
    references: plan.references,
    borrowedIdeas: plan.borrowedIdeas,
    portabilityNotes: plan.portabilityNotes,
    templateStrategy: plan.templateStrategy,
    parameterSpace: plan.parameterSpace,
  });
  atomic(file, entries);
}
