# 任务所在电脑与 Agent 运行位置

> **状态**：权威开发规则（authoritative）
> **读取时机**：判断某个引擎（Harness）在某个任务里能否选用、切换引擎时决定 Agent 在哪台电脑运行、接入新的
> 只能本机运行的引擎，或修改 `agentDeviceId`／`remoteHostId` 的使用方式之前
> **适用路径**：`packages/maker-shared/src/agentPlacement.ts`、`apps/desktop/src/main/maker-ipc/sessionAgentSwitch*`、`apps/desktop/src/main/localDb/ipc/antigravityTaskCreation.ts`、`apps/desktop/src/renderer/components/new-chat/{ChatInput,ModelSelector}.tsx`、`apps/mobile/src/session/{sessionAgentSwitch,sessionSelectableAgents}*`、`apps/mobile/app/sessions/**`、`packages/maker-core/src/agents/antigravity/**`

一个任务涉及几台电脑，各自含义不同。把「Agent 在哪运行」当成「任务在哪」，会把本该可用的
引擎拦掉（2026-11-21，Agy 在三处出现同一错误，见文末）。

## 四个位置概念

| 概念 | 字段 | 含义 | 不能用来 |
| --- | --- | --- | --- |
| 任务所在电脑 | 任务行所在的 Cindy | 持有任务记录、项目文件，命令在这里执行 | — |
| SSH 远端 | `sessions.remoteHostId` | 任务本身在 SSH 主机上，工作目录是远端路径 | — |
| Agent 运行位置 | `sessions.agentDeviceId` | 当前 Claude Code／Codex／Pi 的 Agent 借用同账号另一台电脑或分享来的供应商运行；任务、文件、命令仍在任务所在电脑。`NULL` = Agent 在任务所在电脑 | 判断任务位置；判断只能本机运行的引擎是否可用 |
| 被控电脑 | Desktop `deviceLinkDeviceId`、Mobile 目标设备 | 控制端正在操作的那台电脑；它的任务就在它上面 | 当成 Agent 运行位置 |

旧文档里的「执行电脑」有时指被控电脑，有时指 Agent 运行位置。新写的说明用上表四个名字，
不再单独使用「执行电脑」。

## 只能在任务所在电脑运行的引擎

若接入只能依赖任务所在电脑的 CLI、订阅和进程组运行的引擎，名单和判断只有一个正本：`packages/maker-shared/src/agentPlacement.ts`
（`TASK_COMPUTER_ONLY_AGENT_KINDS`、`runsOnTaskComputerOnly`、`canHandOffToTaskComputerOnlyEngine`）。当前 Cursor 引擎已于 2026-11-26 彻底移除；Agy 已支持在同账号自己的其他电脑上经受限 `--agent` 与隧道 `cindy_exec` 远程运行，但不开放给供应商分享的受邀者或供应商组。

Agy 远程运行时，受限 `cindy-remote` 是否生效只能从 agy 自己的 worker 日志判断：agy 1.5.14
启动时连不上 Google、拿不到功能开关，就记一行 `Agent "cindy-remote" not found` 并改用带全部本地
工具的默认 agent，ACP 回包与正常时一样。`AntigravityAgent.startSession` 在发出首条消息前读日志，
确认进程已退出后重启，最多 3 次，仍失败就报告那台电脑连不上 Google；进程退出未确认时不重启。
本地工具拦截（`acp-remote-tool-blocked`）保留为最后一道防线。依据是 2026-11-23 M3 上 7 次远程
启动有 2 次回落，首条命令即被拦停；回归见 `remote-workspace.test.ts`。

拦截按允许名单判断（`ANTIGRAVITY_REMOTE_ALLOWED_NATIVE_TOOLS`）：除本任务隧道 MCP 外，只放行
`search_web`、`update_steps`、`update_focus`、`exit_plan_mode`、`ask_question`、`schedule` 这几个不碰本机
的 agy 自带工具；其他带名字的工具（含 `invoke_subagent`、`run_workflow`、`swarm`、`browser` 和新版 agy
新增的工具）、调用本任务以外 MCP 服务器的请求以及本地类 `kind` 一律拦停。工具名取 `name`，缺省时取
`Run <工具名>` 形式的标题，两者都先去掉 agy 1.5.18 会加的 `Run ` 前缀。子 Agent、工作流和浏览器 agent
会拿到 agy 默认的本地工具，且它们自己的工具调用不经过这层拦截，所以不能只拦文件／终端工具。

仍会放行的两种帧：参数还没到的 `call_mcp_tool` 进度更新（权限请求不放行，它本应带着参数，放行会让
完全访问下的 agy 自动允许本任务以外的服务器），以及既没有工具名、也没有 `Run <工具名>` 标题的状态更新。
依据是 2026-11-26 核对本机 agy 历史记录：远程任务只用过 `call_mcp_tool`；新增 agy 自带工具前，先确认它
不读写本机、不执行命令、不启动其他 agent。回归见 `remote-workspace.test.ts`。

Desktop 新建页里 Agy 的权限按 Agent 运行位置分两份记：在任务所在电脑运行用 `permissionMode`（默认
Auto），借用另一台电脑时用 `remotePermissionMode`（默认完全访问），各自保留用户的显式选择；读取走
`draftVendorPrefs`，其他引擎不分。原因是 agy 1.5.14 在多数会话里对每次 MCP 工具调用先跑自带的 Sonar
小模型评估（`sir_flash_lite`，约 1.7 秒；换权限档与 `PreToolUse` 钩子都关不掉，自带文件工具不跑），远程
再叠加任务所在电脑上的 Auto 审核明显变慢（2026-11-23 实测）。这是本 fork 的取舍；agy 提供可信 MCP
跳过检查时重新评估。Mobile 新建任务未跟随。回归见 `newMakerDraft.test.ts`。

- **能否切换只看任务位置和角色**：SSH 任务、Orca 角色或远端 Lead／Worker 关联、非 Desktop
  来源（评审、IM 等）不能切；`agentDeviceId` 不参与判断，不得再作为拒绝条件加回去。
- **目标位置固定为任务所在电脑**：切换到这类引擎时，目的地 `agentDeviceId` 一律为 `null`，
  请求里带了其他设备 id 也忽略（Desktop `sessionAgentSwitchHandler.ts`）。控制端选择时同样
  忽略借用目录的设备（Mobile `selectUnifiedComposerModel`），让切换意图明确写入 `null`。
- **交接方式**：跨引擎切换用 Cindy 的对话记录交接，不搬 Agent 运行位置上的原生会话记录；
  只有同引擎换电脑才搬原生记录（`fromDbKind === toDbKind`）。
- **仍然要拦的情况**：控制端正在操作另一台电脑时，本机界面不提供这类引擎（由被控电脑自己
  的能力决定）；这类引擎自己的任务不能被搬到别的电脑。

## 接入新引擎时

1. 新引擎只能在任务所在电脑运行时，加入 `TASK_COMPUTER_ONLY_AGENT_KINDS`，不要另写一份
   `agent === 'xxx'` 的位置判断。
2. Desktop 切换处理和 Mobile 选择器复用上面的函数。Desktop 输入框的可选引擎列表
   （`ChatInput.tsx`）目前直接按 `deviceLinkDeviceId`、`remoteHostId` 与 Orca 字段判断，
   新增引擎时保持同一组条件，不加 `agentDeviceId`。
3. 测试至少覆盖：`agentDeviceId` 有值的本机任务可以切过去，切换后 `agentDeviceId` 为 `null`；
   SSH 任务不能切。参考 `agentPlacement.test.ts`、`sessionAgentSwitchHandler.test.ts` 与
   Mobile `modelPickerHarnessSwitch.test.ts`。

## 历史

2026-11-21：任务「评审acp迁移过程」在本机运行，Claude Agent 借用了另一台设备共享的来源。
Agy 接入时照抄了「没有 `agentDeviceId` 才可用」的条件，Mobile 选择器、Desktop 输入框和
Desktop 切换处理三处都把它拦下，手机上无法切到 Agy。Cursor 早已按任务位置判断，没有这个问题。
修复后三处与 Cursor 一致，并把名单和判断收进 `agentPlacement.ts`。
