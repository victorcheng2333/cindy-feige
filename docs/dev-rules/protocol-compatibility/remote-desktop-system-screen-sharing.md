# 远程桌面能力新增 `systemScreenSharing`（2026-11-09，未发布）

macOS 被控端在允许远程桌面时，于鉴权后的 `capabilities` 回复中增加可选对象
`systemScreenSharing`（`listening`、`hosts`、`user`、`highPerformance`），供 Mac 控制端决定
是否改用系统「屏幕共享」直连。旧控制端与手机端忽略它；
新控制端遇到旧被控端（无此字段）、非 Mac 或校验不通过的地址，一律回退到原 WebRTC 查看器。
旧被控端仅尝试 `.local` 名称。新版追加可选 `addressVerification: 1`，控制端只在显式支持时
调用既有远程桌面 channel 的 `{ op: 'systemSharingProbe', action: 'begin' | 'end', id }`；
id 为 32 位小写十六进制，begin 返回 `{ version: 1, id, port, publicKey }` 或 null。
公钥通过原鉴权通道传递，私钥仅在目标内存；随机 TCP 端口以 Ed25519 签名新挑战和实际本地地址，
用于验证私网 IP 上确为所选 Cindy。验证失败不尝试该 IP，不绕过 Apple 登录；不证明 VNC
端口或 URL 交接后的路由身份。旧端不收到新 op，手机原有查看器不受影响。
端口 10 秒到期；end、宿主停止、账号切换和退出清理，只作用于对应 peer/id，不重置共享连接。
Bonjour 仍依赖局域网名称解析。登录名按 macOS 短名校验后才放进 URL。
自建中转透明转发既有 invoke，无需适配或升级。行为说明见 `docs/remote-desktop.md`。
