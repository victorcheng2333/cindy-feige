# Cursor 引擎退役（2026-11-05；2026-11-26 再次彻底移除）

Desktop、iOS、Android、Host 和独立额度客户端（Mac / iOS 猫猫）完全移除 Cursor 执行、登录、模型选择、SDK 管理、预热及额度查询。
不再声明 Cursor 能力或注册专用 IPC；旧控制端的 Cursor 创建请求由现有参数校验拒绝，
专用草稿和额度通道（`maker:usage:cursor-subscription`）不再列入 allowlist。新版控制端也不再向旧电脑提供 Cursor 选项。

维护者明确要求不兼容实验任务：移除所有 Cursor 只读分支和退役身份判据。一次性清理由
`scripts/purge-cursor-experiment.py` 完成，先备份再按 `agent_kind=cursor` 删除任务及关联记录；
不在产品启动时做迁移，也不保留 Cursor 引擎类型（仅保留上游的外部 Cursor IDE 历史导入能力）。
没有新的 wire 字段、握手或恢复策略；单个退役请求失败不重启设备连接。自建中转继续透明
转发既有 invoke，客户端负责拒绝已退役能力，无需中转适配或版本升级。
