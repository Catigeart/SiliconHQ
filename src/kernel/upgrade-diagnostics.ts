import { cpSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicText } from '../storage/files.js';
import { digest } from './build.js';
import { isDirect } from './research-config.js';
import { instrumentSolverTests } from './numerical.js';
import {
  atomic,
  readJson,
  trustedManifest,
  readTrustedManifest,
  portableManifest,
  type State,
} from './store.js';

// Called under the campaign lock. Only this reviewed, literal instrumentation
// transform is allowed: never copy arbitrary current project tests into a run.
export function enableNumericalDiagnostics(s: State, root: string) {
  if (!isDirect(s)) throw new Error('目前仅支持 direct-trsm 数值诊断');
  if (!['blocked', 'paused', 'ready'].includes(s.status) || s.closeout)
    throw new Error('请先暂停任务；收尾中的任务不可升级测试');
  const trusted = join(root, 'trusted'),
    file = join(trusted, 'tests/solve_workflow.cu');
  const manifestFile = join(root, 'trusted-manifest.json'),
    auditFile = join(root, 'numerical-diagnostics-upgrade.json');
  const before = readFileSync(file, 'utf8'),
    current = trustedManifest(trusted);
  const oldAudit = existsSync(auditFile) ? readJson(auditFile) : undefined;
  if (oldAudit?.status === 'pending') {
    // Recover an interrupted two-file commit, but only for the exact recorded bytes.
    if (digest(before) !== oldAudit.afterHash && digest(before) !== oldAudit.beforeHash)
      throw new Error('待完成升级的测试源码已变化');
    const expected = {
      ...portableManifest(oldAudit.beforeManifest),
      'tests/solve_workflow.cu': digest(before),
    };
    if (JSON.stringify(current) !== JSON.stringify(expected))
      throw new Error('待完成升级的其他冻结文件变化');
  } else if (JSON.stringify(current) !== JSON.stringify(readTrustedManifest(root)))
    throw new Error('冻结测试完整性校验失败');
  const after = instrumentSolverTests(before);
  if (after === before && oldAudit?.status !== 'pending')
    return { changed: false, audit: auditFile };
  const backup = join(root, 'trusted-before-numerical-v1');
  if (!existsSync(backup)) cpSync(trusted, backup, { recursive: true, errorOnExist: true });
  const audit =
    oldAudit?.status === 'pending'
      ? oldAudit
      : {
          version: 1,
          status: 'pending',
          at: new Date().toISOString(),
          reason:
            'user-authorized numerical diagnostics and completion barrier for D2D input copy before nonblocking solve stream; inputs, predicates and tolerances preserved',
          beforeHash: digest(before),
          afterHash: digest(after),
          beforeManifest: current,
          backup,
        };
  atomic(auditFile, audit);
  atomicText(file, after);
  const afterManifest = trustedManifest(trusted);
  atomic(manifestFile, afterManifest);
  atomic(auditFile, { ...audit, status: 'completed', afterManifest });
  return {
    changed: true,
    audit: auditFile,
    beforeHash: audit.beforeHash,
    afterHash: audit.afterHash,
  };
}
