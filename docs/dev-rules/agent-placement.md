# 任务所在电脑与 Agent 运行位置

> **状态**：权威开发规则（authoritative）
> **读取时机**：判断某个引擎（Harness）在某个任务里能否选用、切换引擎时决定 Agent 在哪台电脑运行、接入新的
> 只能本机运行的引擎，或修改 `agentDeviceId`／`remoteHostId` 的使用方式之前
> **适用路径**：`packages/maker-shared/src/agentPlacement.ts`、`apps/desktop/src/main/maker-ipc/sessionAgentSwitch*`、`apps/desktop/src/main/localDb/ipc/cursorTaskCreation.ts`、`apps/desktop/src/renderer/components/new-chat/{ChatInput,ModelSelector}.tsx`、`apps/mobile/src/session/{sessionAgentSwitch,sessionSelectableAgents}*`、`apps/mobile/app/sessions/**`、`packages/maker-core/src/agents/{cursor,antigravity}/**`

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

Cursor 依赖任务所在电脑上的 CLI、订阅和进程组，只能在任务所在电脑运行（Agy 已支持在同账号自己的其他电脑上经受限 `--agent` 与隧道 `cindy_exec` 远程运行，但不开放给供应商分享的受邀者或供应商组）。名单和判断
只有一个正本：`packages/maker-shared/src/agentPlacement.ts`
（`TASK_COMPUTER_ONLY_AGENT_KINDS`、`runsOnTaskComputerOnly`、`canHandOffToTaskComputerOnlyEngine`）。

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
