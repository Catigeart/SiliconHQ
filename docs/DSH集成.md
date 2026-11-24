# SiliconHQ 如何使用 DSH

本插件在 Desktop 随附的 `0.2.2-rc.5` 宿主上验证。升级时要分别检查命令、Settings、Subagent 和 Jobs 的接口，尤其要实际挂载一次 Agent 预设。宿主显示预设组件已加载，仍需检查创建子 Agent 后能看到哪些工具。

| 需求 | 当前实现 |
| --- | --- |
| 与 DSH 界面保持一致 | 设置页和启动确认从宿主的 `@deepseek-ai/dsh-client-ui-primitives` 加载按钮、菜单和弹窗，随宿主切换主题。构建时把该模块、React 和 `react-dom/client` 标记为外部依赖，由客户端模块加载器提供。 |
| 从聊天发起并查看结果 | `ctx.commands.register` 注册 `/sihq`。宿主核对工作流配置并生成本次预览，选择的聊天文本、步骤报告与 diff 随启动或续轮交接。历史以项目和会话定位，展开步骤时再读取完整报告及已保存的委派输入。 |
| 设置工作流角色 | Cordis 插件 schema 的 volatile 字段描述角色及预算。DSH 插件详情页通过 `plugins.bundle.config` 挂载表单，`configForms.mutate` 携带已读 revision 保存到 profile。可合并独立修改，重叠修改在草稿中供用户核对。 |
| 更换 coding agent | 每个角色引用 DSH 已注册的 provider。`ctx.subagents.startActivation` 接收父 Agent、绝对工作目录和该步骤的选项，调用方直接取得结果。支持结构化输出的 provider 接收 `outputSchema`，其余 provider 按提示词交付 JSON，再由 SiliconHQ 校验。 |
| 查看进度和取消 | `ctx.jobs.start` 创建当前会话拥有的任务。阶段变化写进 Jobs，取消传给等待名额或正在运行的子 Agent。只有宿主明确以 `ACTIVATION_LIMIT_REACHED` 拒绝接纳时，插件才自动等待名额并再次申请。 |
| 复审、预算和恢复 | SiliconHQ 保留报告 schema、验收标准、工作区锁和流程快照。每次委派单独记录尝试 ID。恢复可以复用已返回的报告，显式重试才重复派发结果不确定的开发阶段。 |
| 检查命名实例 | 静态检查读取当前 profile 的 provider 和模型目录。用户主动进行实际测试时，通过 `ctx.subagents` 沿用该实例路由，在独立会话及临时目录发起一次委派。 |
| 执行项目验证 | 「运行验证命令」在父会话的工具权限和沙箱内调用 DSH shell，Windows 使用 `pwsh`，其他平台使用 `bash`。宿主前台执行结果提供退出码、标准输出、标准错误、超时和取消状态。后续 Agent 可引用这份报告。 |
| 人工确认、并行与分支 | SiliconHQ 在同一份流程记录中保存待确认项、决定和步骤报告。条件使用报告里的枚举值，独立的只读步骤可并发委派，开发步骤串行。 |
| 迁移工作流 | 导出文件包含流程与其引用的实例。导入时在目标 profile 的注册后端中选择映射，确认后通过 DSH 配置表单提交更新。 |

### 运行进度查询

客户端通过 `ctx.sidebarRightTabs` 和 `sidebar.right.pane.tab` 注册「当前工作流」，使用 `ctx.sidebarRight.openResource` 导航。标签地址保存流程 ID 和显式选中的历史轮次。DSH 自己管理各会话的布局、浮动、关闭与刷新恢复。后台查询仍按当前会话和项目校验，右侧栏服务缺席时复用聊天回执视图。

运行详情通过 DSH Connection 的 `/api/sihqCatalog/runProgress` 查询当前会话和项目的状态。客户端与宿主共用查询参数定义，关闭详情或切换轮次会取消未返回的请求。旧版客户端可继续使用原来的参数和响应。

从 0.13 开始，DSH 多轮流程在下一次保存时把已结束的轮次一次性归档。当前轮次保存在 `workflow.json`，历史分别导出为 `round-1.json`、`round-2.json` 等。SQLite 在同一事务中提交新轮次、历史和进度。浏览旧记录时按原格式读取。已经分开归档的流程需要 0.13 或以上版本恢复。

在 RC5 中，Typert Loader 能发现第三方包的 `./typert`，客户端也支持挂载生成的 Remote。该版本的官方生成器只扫描聚合 TypeScript 项目引用中实际位于 `packages/` 下的包，同一个独立插件放在外层时不会被发现。本插件沿用 Connection 的现有接口。后续升级可用独立包验证生成、挂载和访问控制，再迁移查询。[DSH Remote 开发指南](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/cookbook/adding-a-remote-api.md) · [生成器的包发现实现](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/typert/generator/src/analyzer.ts)

### 工作目录与实例配置

DSH 会话的初始项目与当前有效工作目录可能不同，例如会话已切换到另一个 worktree。启动预览从宿主取得当前目录，确认启动时再次核对，并在往后的每次委派中显式传入已冻结的目录。Git 项目按所属 worktree 取得工作区锁，子目录发起的开发也受同一把锁保护。[DSH 工作目录](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/working-directory.md)

对于已经按模型分别注册的 Codex 或 Claude Code provider，角色可以直接引用各自的 `providerName`，由官方 provider 管理登录、模型和权限。命名实例需要覆盖产品模型或思考强度时，SiliconHQ 使用适配层衔接对应产品；只读 Codex 路径使用 CLI 的只读沙箱。支持独立 `agentPreset` 的 DSH 后端可以按名称引用宿主预设。只读步骤会校验所选预设，确保工具范围符合只读要求。[官方 Codex provider](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-codex) · [官方 Claude Code provider](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent/subagent-claude-code)

启动预检和委派都会核对当前注册名对应的产品、宿主模型供应商、有效预设与后端权限。声明委派深度限制的 provider 遵守 DSH 的 `maxDepth`。运行详情从 DSH 本地子会话取回可核实的实际路由，外部产品仅显示执行者明确回传的值。

### 项目文档与审查策略

项目文档浏览和读取使用当前宿主的 `workspaceFiles.list`、`workspaceFiles.readBytes`。插件以预览时确认的有效工作目录限定文件范围，并将所选原文交给已有的 handoff 管道。可选的 `hw find` 通过当前会话的 DSH shell 执行，选择的路径仍需经过相同的工作区校验。插件安装不依赖 Hypo-Workflow。

严格策略保留原审查报告格式。按阻塞级别验收时，宿主将带位置、证据和修改建议的 P0/P1 问题与 P2/P3 建议分别校验，结合验收标准和检查结果决定是否退回。两套策略共用 DSH 的委派、重试、审批和运行详情。

### 保存执行证据与恢复

工作流可同时保存每轮启动时冻结的 Git diff 和指定步骤首次派发时采集的 diff。普通恢复复用已保存输入，显式重试重新采集步骤级 diff。运行详情按需加载当时的委派输入和报告，人工确认还可读取本轮任务与显式引用的原文。

SQLite 检查点记录已提交的步骤结果、审批决定和运行状态。`workflow.json` 是其导出文件，文件占用等临时错误会留下待补写标记，后续可从检查点重新生成。非 Git 项目同时检查父目录与子目录的开发锁。Windows 上会核对可读取的进程创建时间以识别 PID 复用。旧锁仅含 PID 或系统拒绝读取创建时间时，会保守地保留存活进程的锁。

## 工作流和社区方案

DSH 的 workflow 工具适合由主 Agent 编写并执行编排脚本。SiliconHQ 的修复预算、阶段交接和验收报告已经有可执行的实现，插件直接把这套状态机接入 DSH 子 Agent 和 Jobs。不同模型的凭证、HTTP 客户端以及任务进度展示都由相应的 DSH 服务或 coding agent 管理。[官方 Workflow](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/workflow) · [官方 Subagent](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/subagent)

Visual Workflow 的节点执行器要求当前会话的主 Agent 取得活动流程，维护自己的运行锁、快照和恢复语义。Workflow Lite 把画布编译成计划提示词。SiliconHQ 需要由指定 provider 提交结构化报告、由程序判断验收结果，并在写入结果不确定时等待显式重试。因此模板编辑器使用 DSH 插件设置表单，保存到同一个 profile，执行时复用 SiliconHQ 已有的锁、报告校验和检查点。每次启动冻结步骤、输入及退回路径。[Visual Workflow 节点执行源码](https://github.com/GZX2211/dsh-Visual-Workflow/blob/4cd99b20713ef2a488522ccf5a95807274a1a6ab/src/host/orchestrator/runtime-execute.ts) · [Workflow Lite](https://github.com/xiaoso456/dsh-workflow-lite/tree/4723891c8565d90e4d66a488c31bfd792c0aadf2)

**Product Subagents** 可以作为当前 DSH profile 的外部后端。隔离验收中，DSH `0.2.2-rc.5` 的插件管理器按依赖范围拒绝安装社区版 `0.4.0`。`0.4.1` 已与 SiliconHQ 一同安装并完成工作目录对照测试。各后端的注册名、权限和模型覆盖能力以当前 profile 为准。[Product Subagents](https://github.com/shaokeyibb/dsh-plugin-product-subagents)

纯只读模板在同一工作区可并行运行。含开发或验证命令的模板、内置开发流程占用独占锁。DSH Jobs 接收入场后的步骤进度；子 Agent 派发获准后才计入自动修复预算。开发仍有未完成事项时，独立审查通过后保留「开发未完成」，供下一轮处理。

聊天直输指令通过 DSH 会话事件的 `sourceEventSeq` 关联 Job 和流程。历史列表按项目与会话筛选，首次访问从已有记录构建内存索引，随后仅重读有变动的记录。项目文档的文件名搜索调用 `workspaceFiles.search`，按需求查找继续通过 DSH shell 执行 `hw find`。

### Product Subagents 的工作目录

对 `dsh-plugin-product-subagents@0.4.1` 的本地对照测试中，DSH 会话切换 checkout 后，产品进程仍在原会话目录启动。SiliconHQ 在开发步骤的启动预览和实际委派前检查这项限制，包括自定义 provider 命名空间。遇到提示时，在目标 checkout 新建聊天，或选用支持切换目录的后端。版本和行为可用使用手册中的社区后端验收命令复核。
