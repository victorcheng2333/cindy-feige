# Claude CLI 自动重试状态

继续使用既有 `error` 事件的 `isTerminal: false` / `willRetry: true`。网络重试复用
`Reconnecting... N/M`；SDK 明确报告首字节超时（`no_response`）时首轮即展示，普通瞬时
失败从第二次重试展示。429 使用既有 `(rate-limit-retry N/M)` 标记，追加
`reason: upstream-rate-limit-retry`，Desktop / Mobile 沿用限流重试的本地化呈现。
此 reason 仅作显示，不触发 Cindy 外层重投；Claude CLI 仍是唯一重试执行者。
无新增通道、权限或必填字段。旧控制端对新 reason 按普通可恢复错误显示，新控制端
继续接受原有 `terminal-rate-limit-retry`；真实鉴权／配额终态仍走原错误处理。
