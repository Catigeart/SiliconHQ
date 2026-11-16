import { z } from 'zod';
export const researchIdSchema = z.enum(['diagonal-trtri', 'direct-trsm']);
export type ResearchId = z.infer<typeof researchIdSchema>;
export type ResearchConfig = {
  id: ResearchId;
  version: 1;
  sourceFile: string;
  testFile: string;
  testFiles: string[];
  initializerFiles: string[];
  boost: boolean;
  guide: string;
  sourceRoot: string;
  objective: string;
  contract: string;
  sizes: number[];
  rhs: number[];
  sampling: {
    largeThreshold: number;
    smallGroups: number;
    largeGroups: number;
    smallIterations: number;
    largeIterations: number;
  };
};
export const commonContract = `使用 warp-level 编程模型；明确同步与参与掩码。禁止引入 sm_80 和 sm_90 均不支持的指令；sm_90 专用指令必须编译隔离并有 sm_80 后备路径。sm_120 是本机测试设备，不据此声称 A100/H800 性能。禁止 TF32、降低数值精度、修改测试与容差。只允许修改候选的 src/ 和 include/；不修改库外文件，不启动其他智能体或后台程序，不提交。保持公开 API/ABI。产物目标为跨平台可调方案，局部变慢也可归档。当前是有预算的探索，未测范围不能宣称验证通过。全局目标是多轮研究目标，不要求每轮都完成全部目标；本轮实现任务范围由 plan 与 objective 确定；控制器固定正确性测试契约不随计划缩减或放宽。不得引入新缺陷、降低精度或缩小已有接口支持范围。对于未纳入本轮修复范围的既有基线限制，应准确记录到 limitations 并交给 planner，不把它误报为本轮回归；不能据此宣称全局目标已实现。`;
export const trtriContract =
  `任务：输入仅为一张三角矩阵，FP32 批量求逆指其多个对角块。order 为原矩阵阶数，nb 为块阶数，block_count 为该矩阵的块数；内部 batch 参数仅是实现手段，不优化多张独立大矩阵的批量逆块。nb=32,64,128,256,512,1024。完整块路径支持合法的 nb 倍数矩阵规模；保留非整除尾块正确性。保留 upper/lower、unit/nonunit 和 leading dimension 契约，但不对它们与所有 nb/块数做重复笛卡尔积测试。核心测试与性能固定 lower/nonunit；兼容小集合由控制器按源码变化决定执行或复用，未测模式不能声称重新测过。同一算法族的不同 nb 必须优先共享 template 实现，以参数、编译期分支和必要特化覆盖，禁止仅因 nb 不同复制整套代码。允许有证据支持的不同算法族，公共逻辑仍需复用。` +
  commonContract;
const configs: Record<ResearchId, ResearchConfig> = {
  'diagonal-trtri': {
    id: 'diagonal-trtri',
    version: 1,
    sourceFile: 'src/trtri.cu',
    testFile: 'diagonal_workflow.cpp',
    testFiles: [
      'common.hpp',
      'reference.hpp',
      'correctness.cpp',
      'diagonal_workflow.cpp',
      'benchmark_input.hpp',
      'benchmark_input.cu',
      'correctness_input.hpp',
      'correctness_input.cu',
    ],
    initializerFiles: ['benchmark_input.cu', 'correctness_input.cu'],
    boost: true,
    guide: '/root/gpuhpc-workspace/trtri-ref',
    sourceRoot: '/root/gpuhpc-workspace/references',
    objective: '持续研究可跨 A100/H800 调参的 FP32 warp-level 对角块求逆方案。',
    sampling: {
      largeThreshold: 256,
      smallGroups: 3,
      largeGroups: 1,
      smallIterations: 20,
      largeIterations: 10,
    },
    contract: trtriContract,
    sizes: [32, 64, 128, 256, 512, 1024],
    rhs: [],
  },
  'direct-trsm': {
    id: 'direct-trsm',
    version: 1,
    sourceFile: 'src/solve.cu',
    testFile: 'solve_workflow.cu',
    testFiles: ['solve_workflow.cu'],
    initializerFiles: [],
    boost: false,
    guide: '/root/gpuhpc-workspace/solve-ref',
    sourceRoot: '/root/gpuhpc-workspace/references',
    objective:
      '研究完整三角系统的 FP32 warp-level 直接 TRSM/TRSV，第一期 n=32..1024，nrhs=1..4096 的二次幂；收敛可移植算法族。',
    contract:
      `任务：单个完整三角系统，禁止忽略非对角块；left: op(A)X=alpha B，right: X op(A)=alpha B。n 为矩阵阶数，不是内部块大小；nrhs 为独立右端项数，不是多矩阵 batch。第一期 n=32,64,128,256,512,1024，nrhs=1,2,4,8,16,32,64,128,256,512,1024,2048,4096。性能固定 left/lower/no-transpose/nonunit/alpha=1。保留 side/uplo/trans/diag/alpha/lda/ldb 契约，其他模式定向正确性覆盖，不做性能笛卡尔积。直接求解允许单元素除法或倒数、前代/回代及 GEMV/GEMM 更新；禁止形成任何三角逆或对角块逆，包括寄存器/shared中的逆。不得调用不透明的厂商TRSM/TRSV代替候选直接算法；厂商GEMV/GEMM仅用于更新且严格FP32。固定测试对所有RHS做已知解及double残差检查，对首/中/末RHS做独立CPU long double求解；阈值冻结为1e-5，另测尺度变化、耦合输入、非整tile和alpha=0。B原地覆盖，计时每次必须使用新鲜B0；分配、初始化、恢复在计时外。nrhs=1允许专用TRSV内核，其他RHS优先共享模板；参数变体不另立算法族。审阅须核实完整调用链未计算块逆及alpha只施加一次。
` + commonContract,
    sampling: {
      largeThreshold: 256,
      smallGroups: 3,
      largeGroups: 1,
      smallIterations: 10,
      largeIterations: 10,
    },
    sizes: [32, 64, 128, 256, 512, 1024],
    rhs: [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048, 4096],
  },
};
export function researchConfig(id: ResearchId = 'diagonal-trtri'): ResearchConfig {
  return structuredClone(configs[researchIdSchema.parse(id)]);
}
// A frozen snapshot is persisted with new runs. Legacy runs keep the old driver.
// Unsupported/changed contracts fail closed instead of silently changing live tests.
export function researchFor(s: { researchConfig?: ResearchConfig }): ResearchConfig {
  const snapshot = s.researchConfig;
  const current = researchConfig(snapshot?.id);
  if (snapshot && JSON.stringify(snapshot) !== JSON.stringify(current))
    throw new Error('研究配置版本或内容不兼容；需要原版本控制器或显式迁移');
  return snapshot ?? current;
}
export const isDirect = (s: { researchConfig?: ResearchConfig }) =>
  researchFor(s).id === 'direct-trsm';
export function solveCheckMarkers(n: number) {
  return [
    ...configs['direct-trsm'].rhs.map((rhs) => `CHECK,${n},${rhs},0,PASS`),
    `CHECK,${n},17,1,PASS`,
    `CHECK,${n},17,2,PASS`,
  ];
}
export function solveCompatibilityMarkers() {
  const rows: string[] = [];
  for (let side = 0; side < 2; side++)
    for (let u = 0; u < 2; u++)
      for (let t = 0; t < 2; t++)
        for (let d = 0; d < 2; d++) rows.push(`COMPAT,${side},${u},${t},${d},PASS`);
  for (const n of [31, 33, 65]) for (const rhs of [3, 17, 33]) rows.push(`TAIL,${n},${rhs},PASS`);
  return [...rows, 'ALPHA,1.25,PASS', 'ALPHA,0,PASS'];
}
export function solveSanitizerMarkers(n: number) {
  return [
    ...[1, 3, 33, ...(n === 32 ? [4096] : [])].map((rhs) => `SANITIZE,${n},${rhs},DONE`),
    `SANITIZE,${n - 1},17,DONE`,
  ];
}
export function solveSampling(n: number, nrhs: number) {
  const p = configs['direct-trsm'].sampling,
    large = n >= p.largeThreshold || nrhs >= p.largeThreshold;
  return {
    groups: large ? p.largeGroups : p.smallGroups,
    iterations: large ? p.largeIterations : p.smallIterations,
  };
}
export function solveNcuArguments(
  binary: string,
  n: number,
  nrhs: number,
  log: string,
  library = false,
) {
  const policy = solveSampling(n, nrhs);
  return [
    '--clock-control',
    'base',
    '--cache-control',
    'all',
    '--replay-mode',
    'range',
    '--metrics',
    'gpu__time_duration.sum',
    '--csv',
    '--print-units',
    'base',
    '--log-file',
    log,
    binary,
    library ? 'bench-library-ncu' : 'bench-ncu',
    String(n),
    String(nrhs),
    String(policy.iterations),
    String(policy.groups),
  ];
}
export function assertMarkers(output: string, expected: string[], prefixes: string[]) {
  const rows = output.split(/\r?\n/).filter((r) => prefixes.some((p) => r.startsWith(p)));
  if (JSON.stringify(rows) !== JSON.stringify(expected))
    throw new Error('固定测试结果缺项、重复或无效');
}
