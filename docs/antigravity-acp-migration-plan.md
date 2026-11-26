# Agy 内置引擎：从 CLI stream-json 迁到 ACP

> 状态：`feat/agy-acp` 实施版，2026-11-20。之前的接入背景见
> [Agy CLI 集成方案](antigravity-agent-harness-plan.md)。

## 结论

1. **Agy 会话统一使用 ACP。** 删除会话的 `stream-json` 驱动，沿用 `antigravity`
   引擎和供应商身份。模型目录与能力来自 ACP 握手，订阅额度使用 `agy /usage` 的 JSON。
2. **旧 CLI 测试对话从新 ACP 上下文开始。** 在原任务界面继续发消息时，第一次发送发布新会话
   ID。ACP 创建的会话可以正常恢复。旧的 Cindy 消息仍可查看。
3. **运行使用官方 agy。** `agy --settings '{"useG1Credits":false}' acp --process-per-session
   --disable-telemetry --gemini_dir=<任务目录> --log-file=<任务日志>`。HTTP MCP 需要
   `--process-per-session`。代理读取 Agy 设置，本机 MCP 使用回环地址。
4. **提示词复用已确认。** 通过 `_meta.antigravity.systemPrompt.append` 追加现有 Cindy 共用
   正文、共享记忆和个性化。连接、工具选择和代理配置均由宿主程序决定。

## 1. 本机实测

使用 agy 1.5.13，联网请求走指定 Agy 代理，任务、MCP 地址和附件测试数据各自隔离。

| 项目 | 结果 |
| --- | --- |
| 模型目录 | CLI 返回 27 个变体，Cindy 按 ACP ID 展示 11 个基础模型或单档模型。 |
| 发送前准备 | 发送前拉起进程并完成握手。一次带共用提示词和 MCP 的启动为 3.84 秒，预热后该轮首段文本为 2.91 秒。 |
| 逐轮用量 | `session/prompt` 的 `usage` 包含未缓存输入、缓存读写、带思考的输出和总数。一轮实测 2,369 未缓存输入、11,468 缓存读取、45 输出，共 13,882。 |
| MCP 与权限 | 模型主动调用任务级 HTTP MCP，审批一次，返回工具中的独立校验码。关闭会话后该授权失效。 |
| 图片、文件与提示词 | 模型识别出测试图片颜色，读到了文件内随机码，并按追加的个性化指令回报校验码。 |
| 切档与取消 | 同进程切模型、effort、接受编辑、自动和计划模式。取消通知在一次实测中约 10 毫秒得到取消结果，下一轮继续使用同一原生会话。 |
| 恢复 | 重建进程后恢复同一 ACP ID，模型正确回忆上一轮校验码。 |
| 额度 | JSON 的 `usage` 命令回执为 0 推理轮，分别提供 `5h`、`weekly` 和模型组数据。 |
| 失败形态 | 曾观测到上游地区限制被包在正文里，终态为 `end_turn`。保留了该报文的回归测试，Cindy 将它显示为终止错误。 |

过去的 CLI 首字采样与本次使用的提示词及网络条件不同，两者用于记录各自的耗时。

## 2. 目标架构

```text
Desktop / iPhone 界面（模型选择、权限档、审批卡、预热触发）
        │
antigravity-host.ts（Desktop）
  ├─ 代理环境：Agy 代理设置 → antigravityEnv()
  ├─ 模型目录：ACP 握手（探测会话不发送消息，读取后关闭）
  ├─ 额度：agy /usage（保留，独立于 ACP）
  ├─ 任务目录：owner 作用域 antigravity/acp/<hash(taskId)>/<hash(workingDir)>
  └─ Cindy MCP 桥：getPiExtraSpawnConfig
        │
AntigravityAgent（maker-core，仅 ACP）
  ├─ acp-process.ts 启动、进程组、日志、两段式关闭
  ├─ AcpConnection   JSON-RPC 2.0 / NDJSON，请求、通知、反向请求
  ├─ AcpSession      会话状态机、配置切换、审批桥、身份发布
  └─ AcpUpdateTranslator  session/update → AgentEvent
        │ stdio
agy acp --process-per-session（front）→ worker → 工具子进程
```

### 2.1 文件规划（maker-core）

| 文件 | 职责 |
| --- | --- |
| `agents/agy-acp/connection.ts` | 与引擎无关的 JSON-RPC 层：id 映射、超时、`AbortSignal`、反向请求分发、连接关闭时让所有挂起请求失败。不含 agy 字段，日后接别的 ACP agent 可复用 |
| `agents/agy-acp/protocol.ts` | ACP v1 类型，只收 agy 实际发出过的字段；跳过无法识别的 `sessionUpdate` |
| `agents/antigravity/acp-process.ts` | 启动参数、`detached` 进程组、stderr 丢弃、`--log-file` 位置、关闭（§3.5） |
| `agents/agy-acp/session.ts` | 状态机（§3.1）、模型 / 档位 / 模式映射、审批桥、usage 汇总 |
| `agents/agy-acp/translator.ts` | 事件翻译与错误识别（§3.6） |
| `agents/antigravity/models.ts` | 保留。新增「Cindy 基座模型 + effort」与 `configOptions` 的 `model` / `thought_level` 互转 |
| `agents/antigravity/index.ts` | `AntigravityAgent`：参数校验、能力表、组装上面几块 |
| 删除 | `stream.ts`、CLI 分支的 `--input-format stream-json`、`--conversation`、`--dangerously-skip-permissions` 及对应测试 |

## 3. 关键设计

### 3.1 会话状态机

`starting → idle ⇄ prompting → cancelling → idle`，任意状态 → `closed`。

- `starting`：启动进程 → `initialize`（校验 `protocolVersion`、`mcpCapabilities.http`）→ `session/new` →
  按任务设置下发 `model`、`thought_level`、`mode`。**`session/new` 没返回 `model` 选项时，判为启动失败**，
  归类为网络 / 代理或登录问题提示用户，不留下一个必然失败的会话。
- 同一时间只有一个 `session/prompt`。宿主排队的后续消息等上一轮结束再发。
- 配置切换（模型、档位、模式）在 `idle` 时直接 `set_config_option`；`prompting` 中拒绝并提示等本轮结束，
  与现在一致。
- 进程意外退出：当前轮报错结束，句柄标记不可用；下一次发送重启进程并 `session/resume` 原会话。

### 3.2 预热（保持现有体验）

- 触发点不变：Mac 和 iPhone 草稿在输入时调用句柄的 `prewarm()`，包括无目录草稿（沿用现有草稿任务目录）。
- 预热做完 `starting` 的全部步骤，进程和会话留在 `idle`。**原生会话 ID 不对外发布**，第一次真正发送时才发
  `session_id`，与 CLI 版的延迟发布语义相同。
- 预热草稿的模型、档位或权限改动通过 `set_config_option` 应用到就绪进程，同一草稿仍可接管。
- 改代理：空闲 ACP 进程回收，在途会话等当前轮结束时回收，下一轮按已有 ACP ID 续聊。
- 草稿丢弃或空闲回收：`session/close`（2s 超时）→ 关闭进程组 → 释放 MCP 桥 → 删除草稿任务目录。
- 验收：同模型、同代理、同目录下，预热后首字时间不慢于 CLI 版。

### 3.3 模型与档位

- 目录由 `session/new` 的配置选项和 `models.availableModels` 合成。空目录时用 `agy models` 区分
  未登录和网络错误。成功快照按账号缓存。
- 先使用 ACP 提供的精确型号，再把带档位的 ID 归到实际提供的基础型号。启动和换模型只应用该模型提供的档位，
  无档位模型沿用 Agy 的原生配置。
- 以 `set_config_option` 返回的 `currentValue` 为准更新句柄的 `model`，防止 agy 自行回落到别的模型。

### 3.4 权限

| Cindy 权限档 | ACP 做法 |
| --- | --- |
| 默认 | `mode=default`，转 Cindy 现有审批卡。 |
| 接受编辑 | `mode=accept-edits`。 |
| 自动 | `mode=auto`。 |
| 计划 | `mode=plan`，使用计划模式开关。 |
| 完全访问 | `mode=default`，自动选择 `allow_once`。如果只有记住授权的选项，由用户按 Agy 提供的范围确认。 |

- 完全访问**不用** `--dangerously-skip-permissions`：那是进程级参数，切档又要重启。
- 新建 Agy 任务默认使用 Auto，账号未提供 Auto 时使用默认权限。权限档可在回复中切换，切换后取消旧档挂起的审批。
- Agy 自行进入或退出计划模式时，Cindy 同步开关和任务状态，退出后恢复用户选择的常规权限档。
- Agy 只提供记住授权时，在任务卡按原生选项确认。共享访客可使用允许一次；记住授权由任务主人操作。
- Agy 依据原生规则决定哪些操作发审批请求，Cindy 在收到请求时使用当前权限档处理。

### 3.5 停止与进程回收

1. 用户点停止：回掉挂起审批 → `session/cancel` → 等 `session/prompt` 以 `cancelled` 返回，宽限 5s。
   成功则进程保留，下一轮直接复用。
   若还在读取附件，直接取消本地准备并发布取消终态。
2. 超时未返回：句柄标记不可复用，对整组 `SIGTERM`，2s 后 `SIGKILL`。下一轮重启并 `session/resume`。
3. 关闭任务：`session/close` → 关闭 stdin → 同上两段式整组回收。
4. 已完成的工具回执和 usage 在结束前收齐再发终止事件（保留 CLI 版的做法）。
5. 验收：停止和关闭后，该任务目录下没有残留 agy 进程（按进程组核对）。

### 3.6 事件翻译

| ACP `sessionUpdate` | Cindy 事件 |
| --- | --- |
| `agent_message_chunk` | 流式文本 |
| `agent_thought_chunk` | 显示实际收到的思考块 |
| `tool_call` / `tool_call_update` | 工具卡，按 `toolCallId` 合并，`status` 映射开始 / 成功 / 失败 |
| `plan` | 更新已有的任务计划卡。同一轮重复的更新使用同一个卡片 ID。 |
| `usage_update` | 上下文占用，逐轮 token 由终态回执记账（§3.8） |
| `config_option_update` | 更新句柄的当前模型、档位、模式 |
| `available_commands_update` | 忽略 |

### 3.7 Cindy MCP 与记忆

连接前挂载 `cindy_helper`、`cindy` 和 `cindy_computer`（2026-11-26 补上，见
`antigravity-agent-harness-plan.md` §4.4），启用共享记忆且使用 MCP 存储时挂载
`cindy_memory`。沿用现有任务身份、回环 HTTP、任务级 Bearer 和桥接释放规则。
项目 Markdown 记忆沿用现有文件工具路径。自配外部 MCP 的认证信息保留在 Cindy 的设置中。

### 3.8 用量与额度

终态 `usage` 进入现有订阅用量账本。Agy 的 `inputTokens` 已经扣除了缓存，`outputTokens`
已经包括思考，缓存读写单独记。上下文环继续读取 `usage_update`。
订阅额度读取 `/usage` 的零推理轮 JSON，继续向两端猫猫提供同一快照格式。

### 3.9 任务目录、日志与隐私

状态位于账号范围的 `antigravity/acp/<任务哈希>/<目录哈希>`。关闭后释放 MCP 桥，删除任务或
弃掉草稿时回收其 ACP 状态目录。日志随新任务状态保存，Cindy 丢弃 stderr。Bearer 只在本机
会话建立请求中交给 agy。

### 3.10 会话身份与插入旧测试历史

新目录使用 `cindy-acp-session-id` 记录 ACP ID。旧 CLI ID 进入此路径时建立一个新 ACP 会话，
发送首条消息时发布新 ID。已保存的 ACP ID 通过 `session/resume` 恢复。真实恢复失败会明确报错。

### 3.11 多端

手机使用代理所在 Mac 执行，复用现有模型、权限、审批和预热通道。附件入口由执行端的
`multimodal` 能力决定。设置页登录、退出走 Agy 原生 Google 认证，退出同时影响终端的 Agy。

## 4. 验证范围

- 本机已验证真实回复、MCP、用量、个性化、图片、文件、热切权限、停止和续聊。
- 测试夹具覆盖权限拒绝、等待审批时取消、启动失败、旧 CLI ID 新开和输入缓存归账。
- 手机已有控制通道、草稿预热、权限和附件的自动化覆盖。
- 设置中的登录、取消和退出经过模拟。当前 Google 账号继续用于联机测试。
- 手机真机界面和相同网络条件下的重复延迟对比是独立的发布验收。

## 5. 运行约束

ACP 协议、模型配置和 HTTP MCP 能力在握手阶段读取。登录或模型目录失败显示可执行的错误提示。
引擎失败与恢复作用于对应任务，不重建 Device Link 共享连接。发布时可用默认分支的桌面版本回退。

## 6. 实施依据

- `docs/dev-rules/remote-and-mobile-adaptation.md`：涉及 agent 进程、会话数据与断链恢复，回答「故障半径三问」。
- `docs/dev-rules/maker-core-and-agent-behavior.md`：追加现有 Cindy 产品提示词的确认和验证。
- `docs/dev-rules/log-upload-and-redaction.md`：`--log-file` 位置与上传边界。
- `docs/dev-rules/credentials-and-local-storage.md`：任务目录、日志文件落盘位置。
- `docs/dev-rules/engineering-conventions.md` §3.2：新增测试的价值门槛，测试用真实 agy 录制的回放数据。
- `docs/dev-rules/protocol-compatibility.md`：若能力表经 device-link 下发。
- `docs/dev-rules/architecture-invariants.md`：改到 Desktop 与 Node Host 共用主体时。
