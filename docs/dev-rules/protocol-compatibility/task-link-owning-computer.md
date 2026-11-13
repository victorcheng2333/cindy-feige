# 任务链接保留所属电脑

手机通知路由修复（2026-11-09，#9423）：桌面本机 `notification:show-session-event`
可选追加 `remoteDeviceId`，仅与 `markAttention:false` 配合使用。控制端代发时，
通知深链及 APNs 合并标识均使用任务所属电脑；本机同 ID 任务的摘要、静音、订阅与
完成交接状态不参与该远程通知。缺失归属的远程事件不由 renderer 代发手机通知。
新版桌面生成的深链保持旧格式，旧手机可直接打开。新版手机遇到旧通知，仅在指定电脑
的任务读取返回空记录或 `NOT_FOUND`，且镜像中存在唯一其它同账号归属时修正路由；
权限拒绝、共享任务、网络错误、归属歧义均不改路由。恢复只作用于当前任务入口，
不扫描其它电脑、不重置 peer 或共享 relay；镜像晚到可触发同一次修正。
归属判断取所有原始设备镜像，先沿用既有设备身份映射归一化，再检查唯一性；
不能使用已按任务 ID 去重的展示列表。重新绑定后的旧／新镜像算同一归属，
不同电脑上的同 ID 任务不自动选择。即使展示列表未变，归属变化仍会重新判断。
无新增 wire 字段、能力位、allowlist 或服务端请求。官方推送与个人 JPush 共用同一通知
payload；自建中转仍不声明 notify 能力，任务读取沿原 invoke 转发，无需升级中转。

> 通用规则与 Review 清单见[跨端协议兼容](../protocol-compatibility.md)；本文件只记录这一项能力的协议约定。

任务查询返回可选 `sessionUrl`，沿用 `cindy://session/<id>?device=<deviceId>`。
桌面外部打开与冷启动缓存的 session payload 新增可选 `deviceId`，Main、preload 和
Renderer 均保留它。导航先与本机设备 ID 比较；远端链接先登记现有会话 origin，
再通过原传输层读取，不把相同 ID 的本机伙伴任务当作目标。设备判断沿用入口导航器的
最新点击判据，迟到结果不覆盖后续点击。没有设备参数的旧链接保持原导航流程。
设备比较与链接生成均使用 auth 注册的本机标识，包含隔离开发实例的覆盖值。
外部入口与正文链接按设备和任务 ID 一起挑选远端镜像；显式 origin 优先于其它设备
的同 ID 分片，快照刷新不会将后续读取改到另一台电脑。
不增加 IPC channel、远程授权、重试或连接恢复；离线目标仍由现有传输层报告。
回滚后新增查询字段可忽略，但旧 Desktop 从外部打开远程链接仍有丢失设备参数的限制。
回归入口：`deepLink.test.ts`、`deepLinkIslandEntryBridge.test.ts`、
`botSessionOwners.test.ts`、`orcaSessionIdentity.test.ts`。
