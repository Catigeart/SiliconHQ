# direct-trsm 研究配置

新增的是现有 kernel 控制器的一种研究契约，未引入新 Agent 框架。原 `kernel start` 默认仍为
`diagonal-trtri`；旧状态没有 researchConfig 时按原求逆配置恢复。

配置定义在 `src/kernel/research-config.ts`，集中声明版本、候选编译入口、冻结测试文件、
参考资料、提示词契约、规模和采样规则。新任务把完整快照保存到 state/research-config.json。
恢复时拒绝未知或改变的快照，不静默用新契约覆盖已有任务。更改契约应新增受支持版本或显式迁移。

```bash
sihq kernel start /root/gpuhpc-workspace/warp-trsm \
  --research direct-trsm --time-only --seconds 28800 --no-fast --prepare-only
# 检查打印出的任务 id；以下命令才真正启动，包括基线验证和模型调用：
sihq kernel resume <id>
```

也可以省略 `--prepare-only` 直接启动。8小时只是命令示例；用户应按本次实验需要选择预算。
开发验证没有调用模型、没有启动正式研究。`pause/stop/resume/status/report` 保持原行为；
stop 或总时间到期取消当前工作后，由 planner 记录现场和总结，收尾时间单独记录。

## 固定测试

n=32,64,128,256,512,1024；每个n覆盖13个二次幂RHS（1..4096），并加2个压力用例。
另有27个side/uplo/trans/diag、alpha和非整tile用例。smoke只选n=32，仍覆盖其全部13个RHS及兼容集。
full固定集不受planner本轮任务范围缩减。候选只能编辑src/include，构建配方及测试在控制器冻结区。

性能固定left/lower/no-transpose/nonunit/alpha=1；每组10次，n和nrhs均小于256时3组，否则1组。
基线验证同时记录78个直接求解和78个cuBLAS对照点；cuBLAS在libraryPerformance字段，
它不参与“直接算法已验证”的判断。之后候选只运行直接路径，不重复测厂商基线。
使用NCU base时钟、range replay、cache all；每次求解使用独立B0副本，复制和初始化不计时。
源码/测试/二进制/设备一致时复用正确性，正式计时仍实际运行。

性能证据使用n/nrhs，不借用nb/block_count伪装。比较、报告和诊断都按两维匹配。

```bash
sihq kernel diagnose <id> kernels baseline --sizes 32,1024 --rhs 1,4096 --repeats 1
sihq kernel diagnose <id> paired baseline,1 --sizes 128 --rhs 1,32,4096 --repeats 3
```

direct-trsm未指定诊断rhs时默认1,32,4096；诊断子集不是full验收。
finalize_family时仍执行四种sanitizer×六种n；具体RHS和边界覆盖见warp-trsm的TEST_CONTRACT.md。
证据仅覆盖实际实例和sm_120，不表示A100/H800已经实测。

预算、网络恢复、隔离候选、五阶段执行、诊断单独调度、算法族生命周期和实验文档均复用原实现。
参考导航来自solve-ref，实际引用限定在references目录；禁止把混合源文件整体当作纯直接求解。
