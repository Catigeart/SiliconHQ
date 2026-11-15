import { join } from 'node:path';
import { atomic, manifest } from '../store.js';

import { same } from '../runtime-types.js';
import type { StageContext, StageResult } from '../stage-context.js';
export async function handleDevelop(context: StageContext): Promise<StageResult> {
  const { s, experimentDir, work, model, transition, check, snapshot } = context;

  await model(
    'develop',
    '按本轮计划实现。测试由控制器执行；不要自行构建测试或生成其他目录。若此前中断，先检查现场再继续。',
  );
  snapshot('developed');
  if (same(manifest(work()), manifest(s.parent))) {
    atomic(join(experimentDir(), 'diagnostics.json'), {
      status: 'no_change',
      reason: '源码与父方案相同，跳过重复验证；请提出可执行诊断或新实现。',
    });
    transition('diagnostic_decide');
  } else transition('check');
}
