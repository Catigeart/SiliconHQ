import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readJson, type State } from './store.js';
const read = (dir: string, name: string) =>
  existsSync(join(dir, name)) ? readJson(join(dir, name)) : undefined;
const bullets = (items: unknown[] | undefined) =>
  (items ?? []).map((v) => `- ${String(v)}`).join('\n') || '未记录。';
const cell = (v: unknown) =>
  String(v ?? '—')
    .replaceAll('|', '\\|')
    .replaceAll('\n', ' ');
export function writeExperimentReport(root: string, n: number, retrospective = false) {
  const dir = join(root, 'experiments', String(n));
  const plan = read(dir, 'plan.json'),
    dev = read(dir, 'develop.json'),
    ref = read(dir, 'refactor.json');
  const decision =
    read(dir, 'family_decide.json') ??
    read(dir, 'diagnostic_decide.json') ??
    read(dir, 'decide.json');
  const familyValidation = read(dir, 'family-validation.json');
  const comparison = read(dir, 'comparison.json'),
    san = read(dir, 'sanitizer.json'),
    diag = read(dir, 'diagnostics.json');
  const performance = comparison?.comparison ?? [];
  const cancelled = read(dir, 'cancelled.json');
  const parent = read(dir, 'parent.json');
  const links = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => `[${f}](${f})`)
    .join(' · ');
  const checks = ['first-check.json', 'final-check.json']
    .map((name) => {
      const e = read(dir, name);
      return e
        ? `- [${name}](${name})：${e.passed ? '通过' : '未通过'}；正确性${e.correctnessReuse ? '复用 ' + e.correctnessReuse.path : '执行（细节见证据）'}；性能样本 ${e.performance?.length ?? 0} 组规模。`
        : '';
    })
    .filter(Boolean)
    .join('\n');
  writeFileSync(
    join(dir, 'EXPERIMENT.md'),
    `# 实验 ${n}：${plan?.algorithmFamily ?? '未记录算法族'}

${retrospective ? '根据既有记录整理，未补做实验或新增模型结论。' : '由控制器根据阶段产物生成；分析来自 planner 的实际输出。'}

- 任务：${plan?.task ?? 'implement'}
- 研究问题：${plan?.researchQuestion?.id ?? '历史未记录'}；改动分类：${plan?.changeKind ?? '历史未分类'}
- 算法族：${plan?.familyId ?? 'legacy（历史记录未声明稳定 ID）'}
- 父方案：${parent ? `[parent.json](parent.json)，${parent.path}` : '旧记录未提供显式父方案路径'}
- 轮次状态：${cancelled ? '已取消；未完成阶段不能视为通过' : existsSync(join(dir, 'archived')) ? '已归档' : decision ? '已有决策，是否归档见控制器记录' : '进行中或等待决策'}

## 为什么做

${plan?.hypothesis ?? '未记录。'}

待决策：${plan?.researchQuestion?.decision ?? '历史未记录'}

可迁移认识：${plan?.researchQuestion?.transferableInsight ?? '历史未记录'}

停止条件：${plan?.researchQuestion?.stopWhen ?? '历史未记录'}

预期：${plan?.expectedBenefit ?? '未记录。'}

## 参考依据

${bullets(plan?.borrowedIdeas)}

${(plan?.references ?? []).map((r: any) => `- [${r.symbol ?? r.path}](${r.path})：${r.idea ?? ''}；限制：${r.limitations ?? '未记录'}`).join('\n')}

${(plan?.localEvidence ?? []).map((r: any) => `- 本地证据 [${r.path}](${r.path})：${r.explanation}`).join('\n')}

## 改了什么

${bullets(dev?.changes ?? plan?.changes)}

重构：\n${bullets(ref?.changes)}

模板参数：\n${bullets(dev?.parameters)}

## 验证与性能

${checks || '未执行代码验证；诊断任务不产生新的正确性结论。'}

sanitizer：${san?.status ?? 'not_run'}；实际执行 ${san?.cases?.filter((c: any) => !c.reused).length ?? 0} 项，复用 ${san?.cases?.filter((c: any) => c.reused).length ?? 0} 项。

| 规模（nb 或 n × nrhs） | 本轮 μs | 基线 μs | 基线/本轮 | 父方案 μs | 父方案/本轮 |
|---:|---:|---:|---:|---:|---:|
${performance.map((p: any) => `| ${p.n !== undefined ? `${p.n} × ${p.nrhs}` : p.nb} | ${p.medianUs?.toFixed(3)} | ${p.baselineUs?.toFixed(3) ?? '—'} | ${p.speedup?.toFixed(3) ?? '—'} | ${p.parentUs?.toFixed(3) ?? '—'} | ${p.parentSpeedup?.toFixed(3) ?? '—'} |`).join('\n')}

${familyValidation ? `归档代表最终验证：${familyValidation.passed ? '全部通过' : '未全部通过'}；详见 [family-validation.json](family-validation.json)。` : ''}

${diag ? `诊断状态：${diag.status}；详见 [diagnostics.json](diagnostics.json)。` : ''}

仅限实测设备与固定覆盖；不是 A100/H800 运行验证。不同轮次小幅性能差异不自动具有因果意义。

## 如何解释与处理

${decision?.interpretation ?? decision?.reason ?? '等待 planner 决策。'}

处置：${decision?.disposition ?? '待定'}；动作：${decision?.action ?? '待定'}。

不确定性与未完成工作：\n${bullets([...(decision?.uncertainties ?? []), ...(dev?.remaining ?? []), ...(read(dir, 'final_review.json')?.limitations ?? [])])}

## 研究问题结论

状态：${decision?.questionOutcome?.status ?? '历史未记录'}

${decision?.questionOutcome?.conclusion ?? '尚无结构化研究结论'}

可迁移发现：\n${bullets(decision?.questionOutcome?.transferableFindings)}

目标平台待办：\n${bullets(decision?.questionOutcome?.targetPlatformWork)}

## 下一步

${decision?.nextHypothesis ?? '待定。'}

## 证据

${links}
`,
  );
}
export function writeResearchIndex(root: string, s: State, backfill = false) {
  writeQuestions(root, s);
  const dirs = existsSync(join(root, 'experiments'))
    ? readdirSync(join(root, 'experiments'))
        .filter((n) => /^\d+$/.test(n))
        .sort((a, b) => +a - +b)
    : [];
  if (backfill) for (const n of dirs) writeExperimentReport(root, +n, true);
  const rows = dirs.map((n) => {
    const dir = join(root, 'experiments', n),
      p = read(dir, 'plan.json'),
      d =
        read(dir, 'family_decide.json') ??
        read(dir, 'diagnostic_decide.json') ??
        read(dir, 'decide.json');
    return `| [${n}](experiments/${n}/EXPERIMENT.md) | ${cell(p?.familyId ?? 'legacy')} | ${cell(p?.task ?? 'implement')} | ${cell(p?.hypothesis)} | ${cell(d?.disposition)} |`;
  });
  writeFileSync(
    join(root, 'INDEX.md'),
    `# Kernel 实验索引\n\n任务 ${s.id}；研究模式 ${s.researchMode ?? 'legacy'}。历史结果以各自证据为准；最新不等于最佳。\n\n| 实验 | 算法族 | 类型 | 假设 | 处置 |\n|---|---|---|---|---|\n${rows.join('\n')}\n\n[算法族汇总](FAMILY.md) · [研究问题](QUESTIONS.md)\n`,
  );
  const families = read(root, 'families.json') ?? {};
  writeFileSync(
    join(root, 'FAMILY.md'),
    `# 算法族\n\n每个代表候选单独绑定验证证据；closed 不表示目标 GPU 已验证。历史轮次未声明 familyId 时保持 legacy，不猜测算法分类。\n\n${Object.entries(
      families,
    )
      .map(
        ([id, f]: [string, any]) =>
          `## ${id}\n\n状态：${f.status}；实验：${f.experiments.join(', ')}\n\n${f.closure?.reason ?? '探索中'}\n\n代表：${(f.closure?.representatives ?? []).map((r: any) => `[实验 ${r.experiment}](experiments/${r.experiment}/EXPERIMENT.md)：${r.reason}${f.validationRound ? `；[最终检查](experiments/${f.validationRound}/${r.experiment === f.validationRound ? 'sanitizer' : `representative-${r.experiment}`}.json)` : ''}`).join('；') || '未选定'}\n\n未解决：${(f.closure?.deferredHypotheses ?? []).join('；') || '未记录'}\n\n${portingGuide(f.closure?.portingGuide)}\n`,
      )
      .join('\n')}`,
  );
}

function writeQuestions(root: string, s: State) {
  const all = read(root, 'questions.json') ?? {};
  writeFileSync(
    join(root, 'QUESTIONS.md'),
    `# 研究问题\n\n模式：${s.researchMode ?? 'legacy'}。实现、诊断、复测按 questionId 串联；历史轮次不自动推断研究问题。\n\n${Object.values(
      all,
    )
      .map(
        (q: any) =>
          `## ${q.id}\n\n状态：${q.status}；算法族：${q.familyId}\n\n问题：${q.question.problem}\n\n待决策：${q.question.decision}\n\n预期可迁移认识：${q.question.transferableInsight}\n\n结束条件：${q.question.stopWhen}\n\n实验链：${q.experiments.map((n: number) => `[${n}](experiments/${n}/EXPERIMENT.md)`).join(' → ')}\n\n结论：${q.outcome?.conclusion ?? '尚未形成结论'}\n\n可迁移发现：\n${bullets(q.outcome?.transferableFindings)}\n\n目标平台待办：\n${bullets(q.outcome?.targetPlatformWork)}\n`,
      )
      .join('\n')}`,
  );
}
function portingGuide(guide: any): string {
  if (!guide) return '尚未整理移植与调参说明。';
  return `算法：${guide.algorithmSummary}\n\n默认配置：\n${bullets(guide.defaultConfiguration)}\n\n合法参数与未测范围：\n${bullets(guide.parameterConstraints)}\n\n资源需求：\n${bullets(guide.resourceNotes)}\n\n可迁移结论：\n${bullets(guide.portableFindings)}\n\n目标平台待办：\n${bullets(guide.targetPlatformWork)}\n\n已停止的方向：\n${bullets(guide.abandonedDirections)}`;
}
