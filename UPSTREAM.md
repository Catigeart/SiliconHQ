# SiliconHQ

本插件移植自 [Catigeart/SiliconHQ 的 5aa042e](https://github.com/Catigeart/SiliconHQ/tree/5aa042e53c93d070b1638c8c08020c1945f52194)。工作区保留的上游归档 SHA-256 为 `3ccb1a117c62366c45a2675f12eebb8c4bf6242acd45eae006a1678a4ac1b8ef`。下面保留上游使用说明。插件新增的宿主与客户端入口见 [DSH 集成](docs/DSH集成.md)，本地对运行、恢复和存储的改动可将 `src/` 与上述提交逐文件比较。

用 TypeScript 编写的开发 Agent 命令入口，当前通过 Node 子进程启动本机 Codex CLI。

## 使用

在你想操作的项目目录中运行：

```bash
sihq
sihq "先分析这个项目的结构"
sihq --help
sihq --version
sihq -C /path/to/project
sihq resume --last
```

裸命令打开 Codex 原生交互界面。除 `chat`、`run`、`plan`、`implement`、`review`、`workflow`、`list` 和自定义 `resume` 子命令外，参数原样转发，帮助和版本输出也来自 Codex。
工作目录、环境变量、登录和配置沿用当前 Codex 环境。

## 持久对话入口

在项目目录运行 `sihq chat`，一次启动后连续聊天和执行开发流程：

```text
sihq · /root/my-project
你 > 分析一下项目结构
助手 > ……
你 > /workflow 给项目加入配置文件支持
[astra 规划 → sol 实现 → terra 检查]
助手 > ……
你 > 解释一下刚才的修改
助手 > ……
你 > /exit
```

普通消息在同一个 Codex 主会话中继续，只读分析与讨论。主会话创建时读取 planner 的模型和思考强度配置。
`/workflow` 将需求和近期对话背景交给现有调度器，默认最多修复 2 轮。界面显示阶段和命令进度，完整角色报告保存到运行记录。
流程结束后，状态、实现报告、检查报告和失败汇总交回主对话，支持继续追问；回答按完整消息显示，并非逐字输出。

- `/workflow <需求>`：启动开发流程。
- `/status [workflow-id]`：查看流程状态，默认最近一次。
- `/resume <workflow-id>`：恢复当前项目的已有流程。
- `/continue <workflow-id> <新需求>`：沿用角色会话开始下一轮开发。
- `/help`：显示命令。
- `/exit`：退出并保留已记录的对话。

Ctrl+C 取消当前任务并返回输入提示。同一对话一次执行一个任务，执行中请等待或取消后再输入。
流程失败会显示实际状态；如果流程结束后主对话汇报失败，仍可继续提问或查看状态。

```bash
sihq chat list
sihq chat resume <chat-id>
```

记录保存在 `~/.llm-coder/chats/<chat-id>/`：`chat.json` 保存工作目录、会话 ID、模型、关联流程和近期消息，`events.jsonl` 保存完整事件。
恢复对话沿用原目录、模型和 Codex 会话。中断的开发流程需显式输入 `/resume <workflow-id>` 继续。
主对话与各角色各自维护会话，通过流程报告交接上下文。裸命令 `sihq` 仍打开 Codex 原生界面。

实现：`src/chat/repl.ts` 管理输入和取消，`src/chat/session.ts` 处理对话与流程交接，`src/storage/chats.ts` 保存记录。
`tests/chat.test.mjs` 使用模拟 Codex 子进程验证连续对话、流程交接、恢复、汇报失败、输入错误、会话锁和取消。

## Node 如何启动子进程

原生交互逻辑位于 `src/interactive.ts`：

```typescript
import { spawn } from "node:child_process";

const child = spawn("codex", process.argv.slice(2), {
  stdio: "inherit",
  shell: false,
});
```

- `process.argv.slice(2)` 获取命令参数，每个参数独立传递，保留空格和特殊字符。
- `spawn` 根据 PATH 查找 Codex 并启动子进程。Node 父进程仍然存在，等待子进程结束。
- `stdio: "inherit"` 让 Codex 直接使用终端输入、输出和错误输出，原生界面由 Codex 绘制。
- `shell: false` 不经过 Bash，也不会把提示词中的 shell 字符当作命令执行。
- `error` 事件处理启动失败；`exit` 事件将退出码或终止信号传回调用方。
- 父进程收到 SIGINT、SIGTERM 或 SIGHUP 时会转发给子进程。

```text
sihq
  → /usr/local/bin/sihq（符号链接）
  → dist/cli.js（TypeScript 编译产物，由 Node 运行）
  → spawn("codex", 参数, { stdio: "inherit" })
  → Codex 原生交互界面
```

原生交互入口使用 Node 子进程；受管任务默认通过 Codex app-server 协议执行。

## 编译与安装

依赖：Node.js >=22.13.0、npm。运行时还需要 PATH 中可用且已配置的 Codex CLI。
以下脚本适用于 Bash 环境（Linux/macOS），可从任意工作目录调用。

```bash
cd /path/to/SiliconHQ
./scripts/build.sh
./scripts/install.sh
export PATH="$HOME/.local/bin:$PATH"
sihq kernel --help
```

`build.sh` 使用锁文件执行 `npm ci --include=dev`，编译 TypeScript，生成
`build/siliconhq-<版本>.tgz`。`install.sh` 先执行完整构建，再将安装包安装到
`~/.local`，提供 `~/.local/bin/sihq`；安装后不依赖源码目录，配置文件也随包安装。
将上述 PATH 设置加入 shell 启动文件可永久生效。

自定义安装前缀或安装已构建的包：

```bash
./scripts/install.sh --prefix /path/to/prefix
npm install --global --prefix "$HOME/.local" ./build/siliconhq-0.1.0.tgz
npm uninstall --global --prefix "$HOME/.local" siliconhq
```

安装前缀需有写权限。升级时重新运行安装脚本。旧的 `llm-coder` 命令不会自动删除，
确认新入口可用后，可用原安装方式卸载旧包（例如 `npm uninstall -g llm-coder`）。

开发期间可使用 `npm ci`、`npm run build`、`npm run check` 和 `npm test`。
不安装也可以运行 `node dist/cli.js` 或 `npm start -- --help`。
`npm pack` 会自动编译；`sihq --help` 和 `sihq --version` 仍沿用原生 Codex 转发行为。

角色配置优先读取工作目录中的 `sihq.config.json`，兼容旧的 `llm-coder.config.json`，
最后读取安装包自带的默认配置。历史运行、对话、工作流及锁仍保存在 `~/.llm-coder/`，
以便升级后继续恢复，并保持与旧版的任务锁互斥。

## 通过程序执行任务

```bash
sihq run "分析当前项目结构，不修改文件"
sihq run "分析当前项目结构，不修改文件" > result.txt
```

任务描述必须作为一个参数（用引号包裹）。当前 `run` 不接受额外选项。
程序通过 Codex SDK 接收结构化事件，进度输出到 stderr，Agent 回答输出到 stdout。
显示会话 ID、命令和文件变更进度、回答及 token 用量。回答按完整消息显示，并非逐字输出。
`run` 使用 PATH 中的 Codex，沿用本机配置和当前工作目录，允许在非 Git 目录执行。
它是非交互执行；不提供原生界面的审批对话。没有额外开启跳过权限或沙箱的选项。
任务失败返回 1，参数错误返回 2，取消返回 130。Ctrl+C 可以取消 SDK 执行。

代码入口：`src/cli.ts` 负责命令分流，`src/interactive.ts` 启动原生界面，
`src/adapters/codex.ts` 封装 SDK 与事件处理。`src/execution/prepare.ts` 准备任务，`src/execution/tasks.ts` 提供共享执行器，手动命令和 workflow 都复用这两层。

运行 `npm test` 验证事件失败、流中断和正常完成的处理。

## 运行记录和恢复

```bash
sihq run "分析项目，提出改进方案"
sihq list
sihq resume <run-id> "继续实现第一项改进"
```

记录保存在 `~/.llm-coder/runs/<run-id>/`：

- `run.json`：原始需求、工作目录、创建/更新时间、状态、Codex 会话 ID 和最近错误。
- `events.jsonl`：每轮请求、SDK 事件（含回答）和结束状态，逐行追加。
- `lock`：运行期间的进程锁，避免同时恢复同一任务。

`list` 显示 run-id、状态、UTC 更新时间和原始需求。`resume` 使用原工作目录和 Codex 会话，
追加一轮后续指令；不会自动从失败命令处续跑。没有建立会话的失败任务需要重新 `run`。
历史事件保留，`run.json` 状态代表最近一轮。强制杀进程可能留下 running 状态和锁；
恢复时检查锁中的进程，已结束则允许恢复。不要在不同主机间共享这一进程锁目录。

`sihq resume --last` 仍转发给 Codex 原生界面；自定义恢复必须使用 run-id 和后续指令。

## 生成开发计划

```bash
sihq plan "给项目加入配置文件支持"
sihq resume <plan-run-id> "缩小范围，只处理第一项需求"
```

planner 使用 Codex 的 read-only 沙箱和 never 审批策略：不能通过审批升级写权限。
模型输出需通过 JSON Schema 和本地 Zod 校验；失败时任务标记 failed，不保存新计划。
校验成功后保存为 `~/.llm-coder/runs/<run-id>/plan.json`，包含：
`goal`、`steps`（description/files/validation）、`acceptanceCriteria`、`risks`。
恢复 planner 任务仍为只读规划，沿用记录中的模型；成功后更新 plan.json，历史回答保留在事件日志。
若修订失败，plan.json 可能仍是上一轮成功版本，使用前应确认 run.json 状态。
结构校验保证格式完整，计划内容是否合理仍需审查。

模型和思考强度配置在 `sihq.config.json`，由 `src/config/roles.ts` 统一读取和校验：

```json
{
  "roles": {
    "planner": { "model": "gpt-6-astra", "reasoningEffort": "medium" },
    "developer": { "model": "gpt-6.1-sol", "reasoningEffort": "medium" },
    "reviewer": { "model": "gpt-6.1-terra", "reasoningEffort": "medium" }
  }
}
```

优先使用任务工作目录的 sihq.config.json，其次兼容 llm-coder.config.json，否则使用本工具根目录配置；不逐字段合并。
配置必须包含三个角色及各自的 model，reasoningEffort 可省略，创建新任务时默认为 medium。
支持当前 SDK 的 minimal、low、medium、high、xhigh、max、ultra、persistent 枚举；
具体模型是否接受该档位由 Codex 判断。例如可把 planner 改为 high，同时保留 developer 为 medium。

创建角色任务时将 model 和 reasoningEffort 一起保存到 run.json，随后传入 SDK 的 model 和
modelReasoningEffort。恢复与修复沿用运行记录，不重新读取角色配置；新建的后续角色任务读取当时配置。
旧运行记录若没有 reasoningEffort，恢复时保持原先行为，不覆盖 Codex 自身配置。
裸命令和普通 run 沿用 Codex 的模型配置，不使用这份角色配置。
配置文件是运行时读取的，修改无需重新构建 TypeScript。

## 按计划实现

```bash
sihq implement <plan-run-id>
sihq resume <implementation-run-id> "继续完成剩余工作"
```

只接受状态为 completed 的 planner 记录，并再次校验 plan.json。
创建独立的 developer 运行和全新 Codex 会话，使用原项目目录、developer 配置模型，
workspace-write 沙箱和 never 审批策略。不会自动提交；已有改动通过指令要求保留。
当前没有 worktree 隔离；受管理的任务和 workflow 会对同一个真实工作目录加锁。原生 Codex 界面、外部编辑器和嵌套目录任务不受这把锁管理。

运行目录额外包含：

- `plan-snapshot.json`：原始需求、来源计划 ID/版本时间和计划快照；恢复始终读取此快照。
- `git-before-<timestamp>.json`：每轮开始时的 Git 状态、未暂存与暂存 diff；Git 文件额外保存 SHA-256（最多 2000 个，每个不超过 10 MiB；超限与读取错误显式记录），包含未跟踪且未忽略的文件；不备份内容。非 Git 项目会明确记录 unavailable。
- `implementation.json`：通过校验的实现说明、文件变化、验证命令/结果/证据、剩余工作。

`run.json` 保存 sourcePlanId 和 implementationOutcome。
completed 表示执行和报告生成结束；implemented 是实现者自述，该实现任务本身不代表 terra 验收通过，需另行执行 review。
incomplete 返回退出码 1，list 会显示 completed/incomplete。恢复失败时旧报告可能仍在，
请以当前运行状态及事件日志判断有效性。权限或环境导致验证无法执行时，报告应注明 not_run。

## Terra 独立检查

```bash
sihq review <implementation-run-id>
sihq resume <review-run-id> "重新检查此前受阻的验收项"
```

review 接受 completed 的 developer 任务（包括 incomplete 报告），创建全新 terra 会话，
使用原工作目录和 reviewer 模型，以 read-only 沙箱、never 审批执行。它读取实际代码，
对照原始需求和计划逐项检查；不会自动修复代码。需写入构建文件的测试可能受阻，
必须报告 not_run/not_verified，不能据此判定通过。

运行目录保存 `review-snapshot.json`（需求、计划、实现报告和 Git 基线）、
`git-review-*.json`（每轮检查前的当前 Git 状态）以及 `review.json`（独立检查报告）。
报告包含逐项验收证据、问题位置/严重性/修复要求、检查命令与结果、局限。
程序校验验收标准完整性，并拒绝证据状态与通过结论矛盾的报告。

结论为 passed、changes_requested 或 blocked；后两者退出码为 1。
运行 completed 只表示报告已生成，验收结论见 reviewVerdict 和 list 输出。
执行异常或报告校验失败则为 failed；旧 review.json 可能仍在，以当前状态为准。

检查对象是当前工作区，而非冻结的提交；请避免检查期间修改该目录。
修复后建议重新 review 原实现任务，创建新的独立检查；旧检查结果不会自动失效。
带参数的 Codex 原生 review 可直接用 `codex review ...`；sihq review 现在专用于任务 ID。
独立 review 仅报告结果；workflow 会按下述规则将问题交回 sol。

## 自动开发流程

```bash
sihq workflow "实现一个功能并补充测试"
sihq workflow "不自动修复，检查失败后生成说明" --max-repairs 0
sihq workflow list
sihq workflow status <workflow-id>
sihq workflow resume <workflow-id>
```

默认流程为 astra 计划 → sol 实现 → terra 检查。只有 terra 给出 passed 才成功退出。
changes_requested 会把完整检查报告（问题、证据、修复要求和验收项）交给原 sol 会话，
沿用固定计划快照修复；随后创建新的 terra 任务和独立会话复查。
默认最多修复 2 轮，可用 `--max-repairs 0|1|2` 调整；最多总计 3 次检查。
修复额度耗尽仍未通过时，额外执行 developer 失败分析 → planner 最终汇总两步，不增加修复或检查轮数。
不会自动修订计划、提交 Git 或无限重试。

停止规则：

| 情况 | 流程状态 | 退出码 |
| --- | --- | --- |
| terra 验收通过 | passed | 0 |
| 验证环境或证据受阻 | blocked | 1 |
| 修复预算耗尽，developer → planner 收尾完成 | repair_limit_reached | 1 |
| 模型调用、报告校验或执行失败 | failed | 1 |
| Ctrl+C / SIGTERM 取消 | cancelled | 130 |

blocked 和阶段异常不会自动交回 sol。实现者报告 incomplete 仍会交给 terra 独立判断。
repairCount 表示已经发起的修复轮数，修复本身失败也会占用该轮。

流程记录位于 `~/.llm-coder/workflows/<workflow-id>/workflow.json`，包含需求、目录、
各阶段 run-id、阶段结果、最新 review-id、修复轮数和停止原因。
每轮交接另外保存 `repair-N-feedback.json`。阶段启动前及结束后都会更新流程记录，
详细回答和工具事件仍保存在对应 runs 目录。sol 修复复用实现 run-id，历史保留在事件日志；
每次 terra 检查都有独立 run-id 和快照，不覆盖之前结论。

`workflow resume <workflow-id>` 从原工作目录继续已有流程，不创建新的 workflow-id。
它先获取流程锁和工作区锁，拒绝接管仍有活动进程锁的任务，然后根据最近阶段恢复：

- 阶段已完成且产物校验通过：复用结果，进入下一阶段。
- 阶段未完成且有 thread-id：恢复原 Agent 会话，要求检查现场、避免重复已完成操作，再输出完整报告。
- 尚未获得 thread-id：在同一个 run-id 下启动该阶段的新会话。
- Agent 已完成、但流程记录没来得及更新：核对 executionId 和有效产物后补齐记录，不重复调用 Agent。
- 报告丢失或损坏：继续当前阶段重新生成有效报告。

修复中断后仍继续原修复轮次，保留原始反馈和预算，不会额外增加或重置 repairCount。
passed 流程再次 resume 会复用有效结论；repair_limit_reached 不会获得新的修复额度；缺少收尾说明的旧流程会补做 developer → planner 汇总，已汇总则直接重显说明。
blocked 流程显式 resume 会在原 terra 会话中重新检查，适合环境问题处理后继续。
恢复不可用的会话仍会报错，不会悄悄换新会话丢失上下文。

这是一种阶段级恢复：Agent 自己检查并继续内部工作，不保证从某条命令中间精确续跑，也不保证副作用只发生一次。
恢复时使用当前工作区，不自动回滚文件或判断全部外部改动；已有 passed 报告不会因为工作区变化自动作废。
工作区缺失或移动时恢复会报错，目录需要先恢复可访问。
强制杀进程可能留下 running 状态；旧进程结束后，恢复会回收其进程锁。
直接对 run-id 使用单阶段 resume/review 仍不会自动推进 workflow，推荐优先使用 workflow resume。
有限修复循环上线前的旧串行流程默认修复预算为 0，不会因升级而额外执行修复。

执行直接修改原目录。工作目录锁覆盖整个流程，并与手动阶段命令共用，避免同目录的受管理任务竞争。
历史检查结论只针对当时的工作区，后续改动不会自动使历史报告失效。

## 调度实现与验证

- `src/cli.ts`：参数、信号和退出码。
- `src/config/roles.ts`：角色模型和思考强度的配置读取、校验。
- `src/roles/types.ts`、`src/roles/index.ts`：统一角色接口与注册表。
- `src/roles/planner.ts`、`developer.ts`、`reviewer.ts`：提示词、输入输出格式及纯校验函数，不读写文件。
- `src/workspace/git.ts`：Git 状态、diff 和文件哈希采集。
- `src/execution/prepare.ts`：创建角色任务、冻结配置和交接快照、准备上下文与 Git 基线。
- `src/execution/tasks.ts`：按注册表统一执行角色、保存报告和校验历史产物，不设置进程退出码。
- `src/workflow/runner.ts`：串行调度、阶段恢复、检查反馈交接和有限修复。
- `src/storage/workflows.ts`：流程记录。
- `tests/workflow.test.mjs`：正常串行、阶段失败、blocked、工作区锁、有限修复，以及会话恢复、产物修复、检查点补齐和预算保持。

真实 demo 位于 `/root/SiliconHQ-workspace/workflow-demo-verified`。
首次 demo 暴露了未跟踪文件缺少内容基线的问题；因此补充了 SHA-256，供 terra 独立核对既有文件。

三个角色文件遵循同一约定：声明输出 schema、纯提示词函数和 RoleDefinition。
reviewer 额外保留验收项完整性及结论一致性校验，这是角色自身的业务规则。
准备阶段在执行层完成文件读写；提示词函数只接收已准备的数据。
因此调用 buildPrompt 或校验历史报告不会隐式创建文件、采集 Git 或追加日志。

## 修复耗尽后的用户说明

```text
最后一次 terra 检查仍不通过
  → developer_feedback：developer 分析失败原因与遗留问题
  → planner_summary：planner 综合 developer 反馈与原始检查证据
  → 终端显示最终说明，流程以 repair_limit_reached / 退出码 1 结束
```

两个阶段分别使用原 developer/planner 的模型、思考强度和会话 ID，并创建独立 run-id。
它们使用 read-only 沙箱，不继续修改代码；原计划、实现报告和修复计数保持不变。
如果原任务没有会话 ID，则使用同一角色配置及完整交接快照建立新会话。

developer 会收到原需求、计划快照、最终实现报告、最终 review 和历次检查报告，
输出已完成工作、遗留问题与证据、尝试过的修复、原因分析和需要用户提供的信息。
planner 同时收到这份分析和最后 review，输出面向用户的中文说明，包括影响和后续建议。
最终报告的 status 固定为 repair_limit_reached，不能将失败改成通过。
终端显示可读文本，完整模型事件仍保存在各自事件日志中。

流程目录额外保存：

- `summary.txt`：可直接阅读的最终说明。
- `summary.json`：结构化的 planner 最终报告。
- `workflow.json` 中的 developerFeedbackRunId、finalSummaryRunId 和 summaryFile：收尾任务及产物索引。

收尾任务目录保存 developer-feedback.json / final-summary.json，以及各自的输入快照。
可以通过 `sihq workflow status <id>` 找到这些记录。

收尾模型调用失败时，流程为 failed，stopReason 为 closeout_failed；failureReason 仍记录原来的
repair_budget_exhausted，最后 review 也会保留。运行 `workflow resume <id>` 只继续未完成的收尾阶段，
不重新启动修复。若两个阶段已完成，resume 直接展示保存的说明，不再调用模型。
blocked 和其他阶段的执行异常仍按原逻辑停止，不进入这条专门针对修复耗尽的收尾链。

实现位置：`src/roles/closeout.ts` 定义两个只读任务的提示词、报告格式和文本渲染，
`src/execution/closeout.ts` 准备快照并保存最终说明，`src/workflow/runner.ts` 控制交接与恢复。

## 同一工作方向连续迭代

```bash
sihq workflow continue <workflow-id> "再支持环境变量覆盖配置"
```

在聊天中使用 `/continue <workflow-id> 再支持环境变量覆盖配置`。`/resume` 继续当前轮次；`/continue` 创建下一轮需求。
当前轮次必须为 passed 或 repair_limit_reached；失败、中断、验证受阻的轮次先 resume 处理，不能被新需求覆盖。

workflow ID 保持不变；`round` 表示当前轮次，`rounds` 保存已结束轮次的完整记录（不递归嵌套历史）。
新轮次创建新的计划、实现、检查 run-id 和快照，继承上一轮各角色的会话 ID、模型与思考强度。
上一轮收尾产生了 developer/planner 反馈时，从对应收尾会话继续；terra 从上一轮最后的检查会话继续。
各角色必须重新核对当前代码，并按新需求生成完整报告，旧验收结论不代表新一轮通过。
第一轮修复复查仍创建独立 terra 会话；续开发轮次的检查继承上一轮 terra 上下文，各次检查仍保存独立报告。

每轮继承 maxRepairs 配额，repairCount 从 0 开始；历史运行报告保留。
第一轮流程级文件保留在流程根目录，后续修复反馈与失败汇总写入 `round-N/`，避免覆盖旧轮次文件。
`workflow status <id>` 返回当前轮次及历史；聊天 `/status` 显示当前轮次。
恢复只继续当前轮次，不重复执行已归档轮次，也不增加修复额度。

当前续开发依赖原 Codex 会话可恢复；会话不可用时返回失败，不会悄悄换成新会话。
这些流程仍在同一个项目目录串行执行，未引入 worktree 或并行开发隔离。

## 速度配置

每个角色支持 `speed: "inherit" | "standard" | "fast"`，省略时为 `inherit`：

```json
{
  "roles": {
    "planner": { "model": "gpt-6-astra", "reasoningEffort": "medium", "speed": "inherit" },
    "developer": { "model": "gpt-6.1-sol", "reasoningEffort": "medium", "speed": "fast" },
    "reviewer": { "model": "gpt-6.1-terra", "reasoningEffort": "medium", "speed": "standard" }
  }
}
```

`inherit` 不向 Codex 传速度覆盖，沿用其配置和默认行为；不等于标准速度。
`standard` 显式传 `service_tier="default"` 和 `features.fast_mode=false`；
`fast` 传 `service_tier="fast"` 和 `features.fast_mode=true`。不修改全局 Codex 配置、模型或思考强度。
这里记录的是请求档位，不承诺服务端实际采用的档位或加速比例。

```bash
sihq workflow "实现配置文件支持" --fast
sihq workflow continue <workflow-id> "支持环境变量" --no-fast
sihq workflow resume <workflow-id> --no-fast
sihq plan "分析需求" --fast
sihq implement <plan-id> --no-fast
sihq review <implementation-id> --fast
sihq run "分析目录" --no-fast
sihq resume <run-id> "继续" --fast
sihq chat --no-fast
sihq chat resume <chat-id> --fast
```

执行命令的参数覆盖角色配置；workflow 参数作用于该轮所有角色，包括修复与失败收尾。
速度保存到 run.json，流程级覆盖保存为 workflow.json 的 speedOverride；无参数恢复沿用已记录设置，显式参数更新后续执行使用的档位，不重跑已完成阶段。
`continue` 默认沿用上一轮设置，也可以显式覆盖新一轮，旧轮次记录不变。
`chat --fast` 只控制主对话，不隐式覆盖其启动的 workflow。聊天命令格式：

```text
/workflow --fast 实现配置文件支持
/continue <workflow-id> --no-fast 支持环境变量
/resume <workflow-id> --no-fast
```

聊天选项放在需求前，continue/resume 放在 ID 后。需求正文内的 `--fast` 不会被误当成选项。
CLI 可以用 `--` 结束选项解析；聊天需求以选项字面量开头时也可用 `--` 分隔。
同时指定 `--fast` 与 `--no-fast` 会报错；list/status 查询命令不接受速度参数。
裸命令与原生 Codex 参数转发行为保持不变，以上选项用于 sihq 自己的执行子命令。

## 有预算的 kernel 优化任务

这是独立于通用 `workflow` 的实验控制器，当前专用于 gpuhpc-trtri 的 FP32 `diagonal_blocks()` 接口。
原项目源码不会被自动修改或覆盖；控制器从原项目复制基线，在任务目录下创建候选，保留每次开发、重构和最终归档快照。

```bash
# 后台运行。默认 full：六种 nb，性能仅块数 4，核心 lower/nonunit。
sihq kernel start /root/gpuhpc-workspace/gpuhpc-trtri \
  --experiments 2 --seconds 3600 --calls 16 --tokens 1000000 --stage-seconds 600

# 小规模编排验证，仅 nb=32；不能作为完整规模验收。
sihq kernel start /root/gpuhpc-workspace/gpuhpc-trtri \
  --smoke --experiments 1 --seconds 900 --stage-seconds 180 --no-fast \
  --objective "验证编排，保持算法不变，只整理注释，最后停止"
```

正式实验可以只限制实验时间：

```bash
sihq kernel start /root/gpuhpc-workspace/gpuhpc-trtri --time-only --seconds 28800
# 所有预算均不限，由 planner 决策或人工停止
sihq kernel start /root/gpuhpc-workspace/gpuhpc-trtri --time-only --seconds unlimited
```

`--time-only` 取消轮数、调用、token、单阶段时间和阶段尝试次数上限；不接受这些预算的有限值。
所有预算参数都接受 `unlimited`，例如 `--experiments unlimited`；不加 `--time-only` 时其余参数保留默认值。
默认每个模型阶段尝试上限为 2，可用 `--attempts` 调整。仅临时网络/服务错误自动退避重试；
环境故障或其他异常进入 blocked，避免反复执行无法成功的实验。

启动后返回 kernel-id，终端关闭不会停止 worker。加 `--foreground` 可前台运行。
`--fast/--no-fast` 覆盖整个任务的模型配置。planner/developer/reviewer 在创建时读取角色配置并冻结；
refactorer 使用 developer 的配置，但维护独立会话，避免与实现阶段共用上下文。两个 reviewer 阶段使用 reviewer 会话。
planner 的计划与最终决策共用 planner 会话。长时间上下文由 Codex 管理，恢复的事实依据仍是归档文件。

```bash
sihq kernel list
sihq kernel status <id>
sihq kernel experiments <id>
sihq kernel logs <id> --follow
sihq kernel pause <id>
sihq kernel stop <id>
sihq kernel resume <id>
sihq kernel steer <id> "下一轮优先研究 nb=512 的 warp 分工"
```

- `pause`：当前阶段完成后暂停；worker 的状态最终变为 paused 才表示已暂停。
- `stop`：取消当前实验阶段（模型调用、构建/测试或 sanitizer），冻结现场，再进入 closing，由 planner 生成总结后变为 stopped；行为与总时间到期的收尾相同，停止原因记录为 user_stop。已暂停或阻塞且没有 worker 的任务，会启动后台 worker 专门收尾，不继续实验。
- `resume`：继续当前阶段，复用已落盘且源码哈希匹配的报告和测试结果。总结失败时仅重试总结；人工停止并总结完成的任务已经结束，不能重新开始实验。不能接管活动 worker。
- `steer`：追加人工意见，下一次模型调用收到；不会改写进行中的调用。
- `status`：当前阶段、心跳、worker 是否存活、预算、原始错误和控制请求。`logs` 显示状态事件；各模型的详细工具事件保存在实验目录中。

流程：基线验证/计时 → plan → develop → 控制器正确性检查 → review → refactor → 控制器正确性/性能检查 → final_review → planner decide。
五个模型阶段以外，控制器运行构建与测试，planner 最后增加一次结构化决策调用。
新任务启用 family-final-v1：普通探索轮次不跑 sanitizer。planner 在准备结束算法族探索时返回
`action=finalize_family`；对已通过数值/性能和最终审阅的候选，直接 stop + goal_converged
也会被控制器转入最终检查；branch_complete 不再自动触发 sanitizer。新算法族需提供 familyClosure。控制器冻结 final-candidate 后运行 sanitizer，再进入
family_decide，让同一 planner 根据报告决定继续修复、切换分支、暂停或结束。
family_decide 不允许再次请求同轮 finalize_family；旧任务不自动升级测试策略。
正确性或审阅失败会跳过后续修改/性能阶段，直接交 planner 归档并决定下一轮，不在阶段内无限修复。
每次模型尝试都消耗调用预算；无限预算不会把环境故障自动判作候选错误。

planner 可以 continue、pause、stop，并选择 retain/archive/reject；下一轮可以基于 baseline 或本轮通过的候选。
数值/审阅未通过的候选不能 retain，也不能作为下一轮父方案；正确但本机较慢的候选可以 archive。
sanitizer 检出缺陷的候选不能 retain 或宣称 goal_converged；若数值与审阅已通过，可以 archive/reject、
action=continue、parent=current，明确从失败快照继续修复。修复改变源码后必须重新最终检查。
探索中的 retain 只是保留中间候选，不等于算法族最终验证完成。
第一版不自动合并回原项目，不支持任意历史分支选择。时间模式下，单个研究分支完成不会结束任务；
planner 的 branch_complete 会继续下一轮，goal_converged 可结束，environment_blocked 则阻塞等待排查。

研究对象是单张三角矩阵的多个对角块，使用 order/nb/block_count 描述规模，内部 batch 不代表多张大矩阵。
同一算法族应共享模板，通过 NB、warp 分工、tile 等参数适配不同规模；不同算法族或必要特化需要说明理由。
planner 从 `/root/gpuhpc-workspace/trtri-ref` 的导航索引定向阅读 `/root/gpuhpc-workspace/references`，
计划必须记录算法族、实际引用路径/符号/SHA256、借鉴思路、移植限制和模板参数空间。
控制器核验引用属于参考库且哈希匹配，将研究记录持久化，避免后续反复扫描。
五阶段及收尾提示词集中在 `src/kernel/prompts.ts`。

预算限制包括：实验总数、累计 worker 活跃秒数、模型阶段调用次数（一次 SDK turn，可包含多次内部模型/工具交互）、已报告输入/输出 token，以及单阶段超时。
暂停/停止后的离线时间不计入活跃秒数；恢复不重置预算。时间预算通过轮询取消，可能有取消延迟。
token 数在每轮返回 usage 后累计，是软上限，单轮可能超出；异常中断未返回的 usage 无法准确计入，不作为账单硬限额。
轮数、调用或 token 预算耗尽标为 budget_exhausted；单阶段超时标为 blocked。
**实验总时间到期会取消当前轮次，然后进入 closing，由 planner 记录现场并总结，成功后才进入 budget_exhausted。**
取消轮次记录为 cancelled、未验证；保留已完成实验，不把部分测试视为通过。
收尾不受已耗尽的时间、调用、token 或单阶段预算限制；其时间单独记在 closeout.seconds，
因此 `--seconds 28800` 表示八小时实验时间，进程还需额外时间完成总结。收尾调用与 usage 仍记录在总计中。
人工 stop 与到期收尾都使用独立的总结调用，不受实验阶段预算限制；summary.json 的 status 分别为 user_stop 或 time_limit。
收尾期间重复 `stop` 不打断 planner，也不更改最初的停止原因。SIGINT/SIGTERM 同样请求有总结的停止。
总结失败会保存错误进入 blocked；`resume` 只重试总结，不启动新实验。需要以后继续实验时使用 pause，而不是 stop。
恢复不重置预算，也不覆盖冻结的到期现场。
达到轮数上限不代表算法优化成功；completed 表示 planner 主动结束，不代表所有候选通过。

记录位于 `~/.llm-coder/kernel/<id>/`：

- `state.json`、`events.jsonl`、`worker.log`：检查点、控制事件和后台错误。
- `baseline/`、`baseline-manifest.json`：原始源码快照与哈希。
- `research/`、`research-index-manifest.json`：冻结的参考导航；`research-notes.json`：累计引用与算法、模板研究记录。
- `deadline-snapshot/`、`deadline-context.json`：时间到期的冻结现场。
- `stop-snapshot/`、`stop-context.json`：人工停止的冻结现场；两者都包含阶段、报告和实验清单。
- `summary.json`、`summary.txt`、`closeout.events.jsonl`：planner 到期/人工停止总结及调用记录。
- `experiments/N/cancelled.json`：被到期或人工停止取消的轮次记录及原因。
- `trusted/`、`trusted-manifest.json`：启动时冻结的测试代码与接口头文件，候选不能通过修改测试脚本改变验收。
- `baseline-evidence/`：三目标构建、正确性日志、原始性能样本。
- `experiments/N/candidate/`：本轮工作区。
- `developed/`、`refactored/`、`archived/`：阶段源码快照。
- `first-check/`、`final-check/`：构建和测试日志、结构化 evidence。
- `plan.json`、`develop.json`、`review.json`、`refactor.json`、`final_review.json`、`decide.json`、`family_decide.json`：模型报告。
- `finalize-request.json`、`final-candidate/`、`sanitizer.json`、`sanitizer/`：最终验证请求、冻结候选和逐项日志/证据。
- `sanitizer-cache/`：绑定源码、测试代码、二进制、工具版本、GPU UUID/驱动及规模的已通过检查缓存。
- `comparison.json`：逐规模基线比较、eligible 和 localValidationPassed；后者仅在 full 固定本机验证及最终审阅通过时为 true，smoke 始终为 false。targetRuntimeVerified 仍为 false，不表示方案已跨平台成熟。旧归档中的 mature 字段不改写。另记录 sanitizerStatus 与 familyVerificationPassed；后者要求 full 本机数值/性能、最终审阅及 sanitizer 均通过，不代表跨平台成熟。

验证器使用固定 CMake 配方，编译 sm_80/sm_90/sm_120；在本机执行独立高精度参考、相对 rocBLAS 误差、双侧残差、输入保护、输出 guard 和尾部单位阵检查。
核心检查在各 nb 上使用 lower/nonunit，覆盖块数 1/2、非整除尾块、额外 lda 与多个输入族。
新任务使用 split-gpu-v2：每个正确性用例由 correctness_input.cu 单次 GPU kernel 初始化输入，
保留四种输入族、NaN poison、lda/intermatrix padding 和原有数值门槛。初始化同步后下载实际输入，
供独立高精度 CPU 参考和输入未修改检查使用；不再在 CPU 生成整矩阵并上传。
随机数采用确定性按元素生成，保留输入族特征但不与旧 CPU RNG 逐元素相同；旧任务沿用冻结的测试。
upper/lower、unit/nonunit、lda 契约仍保留；另外三个组合仅用 nb=32 的小兼容集合验证，不重复全部规模。
核心与兼容性结果使用统一正确性缓存：源码、二进制、冻结测试、设备与验证策略身份一致且日志哈希校验通过才复用。源码变化会重测，尚不做语义级影响分析。
旧任务沿用启动时冻结的验证器及测试策略。大规模不使用会导致 FP32 溢出的强增长矩阵族。
新任务采用 ncu-base-pitched-v2 性能策略，只测 lower/nonunit、block_count=4。
nb=32/64/128：3 组，每组 20 次；nb=256/512/1024：1 组，每组 10 次。每个规模预热 3 次。
通过 Nsight Compute `--clock-control base --cache-control all --replay-mode range`
采集 `gpu__time_duration.sum`，每组用 cudaProfilerStart/Stop 包围多次完整 diagonal_blocks 调用；
每次 range replay 前清理 GPU cache，组内连续调用复用缓存和 buffer；将 NCU range 时间除以调用次数，再取样本中位数。该指标是 profiler 下的 range 时间，不与旧 CUDA event 指标混比。
报告值为处理 4 个对角块的一次 diagonal_blocks 调用时间；不是分别测 4 块再相加，也不除以 4。
当前每个计算阶段通过 grid/strided-batched GEMM 并行处理这些块，完整调用包含清零、初始逆块和后续合并等阶段。
不使用 NCU 下的程序 CUDA event/wall 计时作为性能结果。保留 ncu-<nb>-4.csv 与 bench-<nb>-4.log。
NCU 缺失、初始化/权限失败、警告或指标缺项均进入 blocked，不静默降级为未锁频测量。
需要安装 Nsight Compute 与 CUDA Profiler API 头文件；旧任务沿用冻结的旧性能策略。
输入通过 cudaMallocPitch 分配，lda=pitchBytes/sizeof(float)，性能测试不使用人为的 order+3。
输入由 GPU kernel 按固定种子一次初始化，没有整矩阵 CPU RNG 或 H2D 上传；输出及 workspace 保持接口规定的线性布局。
输入初始化和同步在预热之前完成。所有 buffer 每个规模分配一次，在预热和采样间复用，不计入性能区间。
LAYOUT 日志记录实际 pitch/lda；新任务冻结 benchmark_input.hpp/.cu，与候选源码分离。
旧任务继续使用冻结的旧分配/初始化策略，不把旧 CPU 输入性能与新 GPU 输入基线混比。
每次算法内部必要的清零和计算仍在测量范围内。
FP32 完整高精度测试尤其 nb=1024 可能很慢；预算不足时会停止，不能把未测项视为通过。

编译通过不能证明目标架构运行正确，也不能证明目标性能；targetRuntimeVerified 固定为 false。
当前只串行化本控制器的 GPU 测试，不控制其他软件的 GPU 负载；比较结果保留原始样本，未作统计显著性结论。
源码哈希与固定验证器用于发现误改，不构成对恶意候选代码的安全隔离。候选必须经人工/模型审阅确认没有篡改比较路径或利用测试漏洞。
sanitizer 在算法族收尾时单独运行 memcheck、racecheck、initcheck、synccheck，不与 NCU 一起运行。
固定 sanitize 入口在每个 nb 执行 lower/nonunit 的 order=4*nb、nb+13、17，各调用一次；
nb=32 额外执行另外三个 upper/lower、unit/nonunit 组合，order=45。所有输入由 GPU 初始化，使用 pitch。
该入口不重复高精度参考、不预热、不采样；只检查运行工具报告与基础有限值，数值契约仍由 core/compat 保证。
full 有 4 工具 × 6 nb = 24 次工具进程，合计 84 个用例执行；smoke 只测 nb=32，不能标记 familyVerificationPassed。
必须同时满足退出成功、完整 DONE 用例记录、零错误摘要；racecheck 还必须零警告。初始化失败、缺失摘要或
用例不完整属于 blocked，不能被 0 errors 的字样掩盖。发现缺陷先停止本轮检查并交回 planner。
总时间和单阶段预算同样约束 sanitizer；到期取消后保存部分结果，由 planner 做到期总结，不继续最终检查。
恢复环境故障时停留在 sanitizer 阶段，复用通过缓存；缓存不接受失败或日志被改动的项。
即使全部通过，也只说明实测输入/编译实例/本机路径未发现这些问题，不证明所有参数、所有调度或目标架构均无缺陷。


本机验证记录：

- `kernel-gpu-correctness-verification/`：GPU 正确性初始化通过四种类型、四种输入族、NaN/guard/可复现性检查；初始化器 memcheck 为零错误。三目标构建及 nb=32/64/128/256 固定核心/兼容检查通过；89 项自动化测试和 4 项相关 CTest 通过。

- `kernel-sanitizer-verification/`：family-final-v1 的 24 次工具检查全部通过，第二次全部复用通过缓存。检查进程累计约 51.5 秒（不含构建），其中 racecheck 约 36.5 秒、nb=1024 单项约 26 秒；仅为当前基线/本机数据。
- 本轮自动化测试 89 项通过，包含收尾触发、失败修复、环境受阻恢复、到期取消和禁止提升失败候选；后续定向回归也通过。

- `kernel-pitched-verification/`：三目标编译、nb=32 固定正确性和六种 nb 的 pitched/GPU-init NCU 性能入口通过；本机六种规模的 lda 均等于 order。初始化独立测试及原核心/兼容 CTest 均通过。
- 同目录 `sanitizer/`：memcheck/racecheck/initcheck/synccheck 实测均因 WDDM debugger interface 未启用而退出 9，不能据此声称已检查或估计运行开销。

- `kernel-ncu-verification/` 归档了新控制器 nb=32 正确性/三目标构建，以及全部六种 nb 的 NCU 性能采样验证；组数为 3/3/3/1/1/1，block_count 均为 4。
- Nsight Compute 2025.4.1 的 `--clock-control base` + range 采集已在本机实际执行成功，未报告锁频或权限错误。采集成功不等于没有热功耗、主机提交或其他 GPU 任务带来的波动。

- `a0a5ee92-23fa-49f5-9e3d-b9a9062ebc36`：10 秒实验预算取消基线构建，planner 额外约 36 秒完成现场总结后停止；没有将未完成测试报告为通过。
- 新 split-v1 验证器实测通过 80/90/120 编译、nb=32 核心和兼容检查及两组性能采样；第二次运行验证兼容缓存复用。

- 控制器自动化测试覆盖正常五阶段、错误候选归档后自动下一轮、预算、阶段超时、暂停/停止/恢复、同任务锁、冻结源码校验和后台 CLI。
- `de51e504-ed05-4a8a-bfc8-bafbf150b675`：真实 Codex 五阶段及最终 planner 决策全部完成，6 次阶段调用；三目标编译、nb=32 smoke 正确性、最终性能采样通过。仅整理注释，eligible=true、mature=false，未启动长期算法搜索。
- `5413ee89-49c2-438d-8fd8-b328807f634f`：验证了后台基线完成后暂停、恢复不重跑基线，以及未通过审阅时归档并停止。
- 专用 CTest 和原有 FP32 n=32 回归通过。`tests/reference.hpp` 从原正确性测试原样提取高精度参考与残差函数，由两个测试入口共享；未修改数值阈值。
- 单次真实演练累计报告约 73 万输入/输出 token（包含缓存输入和 agent 内部多次交互），因此新任务默认 token 软预算设为 100 万；旧任务已冻结预算不变。

强制 kill -9 或系统异常退出不等同于正常 stop。`resume` 会先核对并清理当前版本登记的遗留 agent、构建和测试进程组，再核对阶段产物；所有权不明确时阻塞，不接管。旧版本没有登记的遗留进程仍需人工确认。后台 worker 意外退出后需执行 resume；目前不提供跨机器调度或系统启动时自动拉起。

### Kernel 研究调度与阅读入口

`sihq kernel report <id>` 在任务空闲时生成/更新 `INDEX.md`、`FAMILY.md` 及每轮 `EXPERIMENT.md`。历史文档明确标注“根据既有记录整理”，不新增实验结论。新归档自动生成文档，planner 的 `interpretation`、`uncertainties`、保留理由与下一步直接进入说明；客观数字、实际执行/复用情况由控制器填写。历史任务恢复时保留已冻结阶段，下一次新规划使用新调度协议。

planner 的任务分为：

- `implement`：原有五阶段与固定验收；源码未改变时返回 planner，跳过重复验证。
- `diagnose`：对已归档源码执行 `codegen`（PTX/SASS/资源和指令地址范围）、`kernels`（逐 kernel 耗时与 grid/block），直接反馈 planner。
- `remeasure`：`paired` 交替 A/B、B/A 复测整体调用；每次使用原有 nb 对应采样规则，不改变固定性能契约。

诊断请求包含 `kind`、`targets`（`baseline` 或归档编号）、`sizes`、`repeats`、`reason`。`codegen/kernels` 相同输入默认复用证据；确需重测可指定 `refresh: true` 并说明理由。`paired` 始终实测。不可用诊断会返回明确错误，不能解释成数值检查失败或验证通过。诊断结果不提升候选，也不改变当前开发父方案。

空闲任务也可以手动诊断，结果放在 `manual-diagnostics/`，不自动恢复研究或改写模型决策：

```sh
sihq kernel diagnose <id> codegen 20,21 --sizes 128 --repeats 1
sihq kernel diagnose <id> kernels 21 --sizes 32,128,1024 --repeats 3
sihq kernel diagnose <id> paired 20,21 --sizes 128,512 --repeats 3
# direct-trsm：已有空闲任务先升级冻结测试（备份、审计，不改变输入或容差）
sihq kernel enable-numerical-diagnostics <id>
sihq kernel diagnose <id> numerical 50 --sizes 512,1024 --rhs 2048,4096 --repeats 3
```

逐 kernel 使用 NCU kernel replay、base 时钟、cache-control all，profile-from-start off，只采集专用入口的一次调用；它与整体 range 测量的缓存/replay 条件不同，不能拿各 kernel 耗时直接替代整体性能结论。当前报告给出真实 kernel 名称与几何，不猜测每个 cuBLAS 内核对应的数学阶段。代码体积采用 SASS 指令地址范围（包含 padding），不是独立 ELF section 大小。

构建按源码、冻结验证器、工具链与固定构建配方定位稳定目录，保证相同源码在不同实验中的二进制一致。正确性复用还绑定测试范围、profile、GPU/driver/可见设备与验证器版本，并校验原始日志。sanitizer 复用绑定同一构建二进制、工具版本、设备和用例，逐项记录原始证据。缓存缺失/损坏会重新执行。固定性能阶段仍实际测量，不把旧时间当作新样本。旧版本证据缺少完整身份时保守重测，不补造缓存有效性。

算法族使用稳定 `familyId`；列宽、BK、展开等参数改变不创建新族。换族需 `familyChangeReason`，已关闭族重开需 `reopenReason`。结束参数分支不自动触发 sanitizer。`finalize_family` 必须提供 `familyClosure`：已完成假设、搁置方向、结束原因和各代表保留理由。当前候选需是代表之一，其他代表须同族、已归档并通过数值与审阅。控制器分别验证各代表；失败交回 planner，环境受阻可从该阶段恢复。历史未声明稳定 ID 的实验保留 legacy 标签，不凭名称自动推断族归属。

`references` 仅允许配置知识库根目录内的真实文件与 SHA-256；候选、基线等本地分析使用 `localEvidence`、`hypothesis` 或 `changes`。引用/计划校验错误会带具体反馈请求结构修正，仍受阶段修正预算约束。

连接中断（包括 TLS EOF、stream disconnected）使用原 thread 与落盘现场重试，不额外消耗语义修正次数，但计入实际调用数和运行时间。默认故障窗口 600 秒、最长退避 60 秒，含随机抖动；空闲时可用 `sihq kernel recovery-policy <id> --window-seconds 600 --max-delay-seconds 60` 配置。持续失败进入 blocked；`resume` 开启新的故障窗口。等待期间 pause/stop/时间到期均可生效。只读阶段在失败时也检查源码未变；开发阶段重试明确提示先核对部分修改。收尾总结亦支持有限故障窗口重试，保持原停止原因。


### 算法探索与平台调优

新 kernel 任务默认 `--research-mode algorithm-exploration`；迁移到目标 GPU 后可以使用 `--research-mode platform-tuning`。已有任务只有显式切换才启用研究问题校验，不改写历史计划或冻结的测试契约。

```sh
sihq kernel pause <id>
# 等 status=paused 后，切换研究模式；不重置时间/调用预算或角色配置。
sihq kernel research-mode <id> algorithm-exploration
sihq kernel resume <id>
```

`research-mode` 只允许空闲的 paused/ready/blocked 任务使用。若当前轮已开始实现或验证，则从下一轮规划生效；停在 plan/baseline 时从本轮生效。

规划新增 `changeKind` 和 `researchQuestion`。后者包含稳定 `id`、算法问题、待决策、可迁移认识、停止条件、实验目的、必要性及成功/失败后的动作。同一问题的实现、诊断、复测沿用同一 ID。决策必须返回 `questionOutcome`：ongoing/supported/rejected/deferred、结论、可迁移发现及目标平台待办。已终结问题不能无理由重开，需明确 `reopenReason`。

算法探索模式的控制器拒绝 `purpose=target-tuning`、`measurementUse=target-ranking`。纯参数改动仅允许建立默认实例、资源边界或必要的算法假设检验；整体复测必须用于结构决策，且不同结果应改变决策。审阅角色负责核对实际改动与声明分类是否相符，不能将纯本机参数排名包装为算法改动。分类与必要性仍依赖模型给出的解释，控制器不声称可以从源码自动证明算法新颖性。

`QUESTIONS.md` 将实验链串到同一研究问题下；`FAMILY.md` 增加移植说明：算法结构、验证过的默认配置、合法参数及未测实例、资源需求、可迁移认识、A100/H800 待调事项和已停止方向。完成算法族不要求 sm_120 参数最优，不要求扫完组合；时间预算仍是原预算，未添加参数实验次数硬上限。

新增只读任务 `task=finalize_family`，可直接选择同族已归档且通过匹配源码 full 数值/审阅的代表，提交 `finalization`（结束依据、代表及 `portingGuide`），由控制器逐个运行/复用 sanitizer，随后交 planner 总结。该路径不会制造新代码候选、不会重复开发/重构，也不会改变开发父方案。一个代表失败就不能将算法族标为完成；环境失败保存断点。算法族完成后，应提出新的结构问题，目标平台调参事项保留在移植说明中。

算法族最终反馈必须返回 `familyAction: "close" | "keep_open"`。它与控制整个任务的 `action`、表达研究结论的 `questionOutcome` 独立：例如 `action=continue`、`familyAction=close`、`questionOutcome.status=deferred` 表示结束当前算法族、将未验证问题留待以后，同时继续其他研究。实现轮收尾与归档代表收尾使用同一校验；任何代表未通过时都不能 close。缺少该字段的旧断点决策会反馈给 planner 修正，不通过猜测 action 来迁移，也不会因此重跑开发或验证。


## 内部模块与重构验证

- `src/commands/`：纯参数解析与 chat、workflow、task 命令处理；原生 Codex 转发由入口保留。
- `src/storage/files.ts`：统一数据目录、文件锁、原子写入与带校验的 JSON 读取；各 Store 保留业务规则。
- `src/storage/schemas.ts`：运行、对话和工作流的磁盘记录校验。
- `src/kernel/runtime.ts`：信号、心跳、时间预算与资源清理。
- `src/kernel/model-executor.ts`：模型重试、源码约束和缓存复用；`artifacts.ts` 校验缓存模型报告和验证证据。
- `src/kernel/stages/`：每个实验阶段的处理器；runner 负责阶段调度与结束状态。
- `src/kernel/state-schema.ts`：kernel 状态格式校验。无版本旧记录按 v0 读取并迁移到 v1，下次保存落盘；未知版本拒绝恢复。
- `src/workflow/runner.ts`：支持注入 RunStore、WorkflowStore 和任务执行器；恢复策略单独判断是否复用已完成执行。

`npm run format` 统一源码和测试格式，`npm run format:check` 检查格式。
运行 `npm run check` 和 `npm test` 验证类型及行为。`tests/refactor.test.mjs` 覆盖清理失败、记录迁移、缓存损坏、命令解析与注入式恢复测试；kernel 原有测试覆盖预算、暂停恢复和算法族验证。


## 统一执行、故障恢复与持久化

Node 要求 >=22.13.0。默认通过 `codex app-server` 的 stdio JSON-RPC 接入；已验证 Codex 0.169.x。初始化会检查版本，关键事件会检查结构。CLI 升级超出已测版本时会明确阻塞；验证新版本时可显式使用 `SIHQ_ALLOW_UNTESTED_CODEX=1`，但不能跳过关键事件结构校验。`@openai/codex-sdk` 固定 0.169.0 用于类型兼容。需要旧 exec 通道时显式设置 `SIHQ_CODEX_TRANSPORT=exec`；它缺少 turn 状态查询能力，恢复保障较弱，不会自动降级到该通道。

普通任务、聊天、workflow、kernel 阶段与 planner 收尾共用执行器：

- `willRetry=true` 表示 Codex 正在内部恢复，控制器不会另起调用。最终依据 turn 的终态，而不是 error 文本或事件名判断成功。
- 终止的暂时性故障采用指数退避与随机抖动；有结构化 Retry-After 时使用该等待时间。恢复截止时间会取消仍在运行的重试，不只限制退避次数。
- 认证、请求配置、协议不兼容和现场完整性错误阻塞；模型输出校验错误使用独立的有限纠错；数值失败仍走实验决策。
- 恢复先检查旧进程、turn 历史与源码指纹。已完成但未登记的结果补登记；部分修改保留并提示 agent 核对。请求可能已提交却无法确认结果时，不盲目重复提交。
- 同一逻辑操作有稳定 ID，失败重试不会改成新的开发需求。显式的新需求/修复仍使用新的操作 ID。
- agent 和测试命令使用登记的独立进程组。取消先通知 agent，再终止进程组并确认退出；超出宽限才发送 SIGKILL。进程记录包括启动标识、boot ID 和所有权 token。
- GPU 被另一项 sihq 验证占用时等待资源，可被 stop/预算到期取消，不把竞争资源记成算法失败。

每个 run/chat/workflow/kernel 记录目录增加 `runtime.sqlite`。SQLite 中的阶段状态、操作结果和执行事件是恢复依据，原 `run.json`、`workflow.json`、`chat.json`、`state.json` 继续作为可读导出。**修改这些导出 JSON 不会改变已迁移任务的执行状态。** 旧记录首次保存时才迁移，原 JSON 保存在 `legacy-records/`，源码、日志和历史实验不搬迁。文件产物先写入并校验，阶段提交同时保存关联操作记录；崩溃留下的结果可从数据库恢复导出。

运行锁使用事务化所有权记录，兼容读取旧 PID 锁；新锁区分进程启动时间，释放时检查 token。`kernel status` 增加 `execution`、结构化 `failure`、资源等待 `activity` 和 `recoveryRequired`；`*.wire.jsonl` 保留 Codex 原始协议事件。

| 环境变量 | 默认值 | 含义 |
| --- | --- | --- |
| `SIHQ_RECOVERY_WINDOW_MS` | 600000 | 一次连续故障的恢复窗口，0 表示不自动重试 |
| `SIHQ_MAX_RETRY_DELAY_MS` | 60000 | 指数退避的最大等待；服务端 Retry-After 仍受总恢复窗口约束 |
| `SIHQ_IDLE_TIMEOUT_MS` | 600000 | agent 无可观察进展检测；0 关闭。重连通知不刷新进展时间 |
| `SIHQ_OUTPUT_CORRECTIONS` | 2 | 模型输出校验的纠错次数，与网络恢复分别计数 |

kernel 已保存的 recovery-policy 优先于窗口与退避环境变量。无进展检测依赖 agent 事件；长时间无输出的合法工具调用可适当调高或关闭检测。它与研究预算分开；`--time-only` 仍可只限制总实验时间，网络恢复等待计入运行时间。

stop 与时间到期都会取消当前实验、冻结现场，然后执行独立的 planner 总结。总结也使用共享恢复策略。若 planner 不可用，`summary-pending.json` / `summary-pending.txt` 提供控制器事实记录；这不代表 planner 已总结。之后 resume 只恢复总结，不重新实验。

`tests/recovery.test.mjs` 使用实际子进程注入重连、部分写入、确认丢失、协议损坏、无进展、取消和 worker 崩溃；数据库测试会在事务中 SIGKILL 写进程，验证恢复。原 exec 集成测试显式选择兼容通道，并关闭自动恢复以保持其阶段失败测试语义。

### 直接 TRSM/TRSV 研究

`kernel start` 新增 `--research direct-trsm`，实验项目为 `/root/gpuhpc-workspace/warp-trsm`。
复用既有五阶段、预算、恢复及归档；`--prepare-only` 可仅冻结任务配置和测试，不启动 Worker。
默认研究配置仍为 `diagonal-trtri`。详见 [direct-trsm 使用与测试契约](docs/direct-trsm.md)。

数值诊断记录首个失败元素的行列、实际值、参考值、绝对误差、容差、lda/ldb/ldx 和 CUDA 状态。诊断用例通过不等于完整验收通过。direct-trsm 测试在默认 stream 的 D2D 输入复制后显式等待完成，再启动 non-blocking 求解 stream，防止输入未就绪导致偶发数值错误；同步不在性能计时区间内。冻结测试升级保留旧版本和哈希审计，旧归档结论不被覆盖，新的验证使用新的测试指纹。
