# 猫猫 Mac

独立的 macOS 菜单栏应用，直接查看同一 Cindy 账号下各台电脑的 Claude / ChatGPT 订阅额度。当前版本 0.1.3。
当前 Mac 不需要运行 Cindy；提供额度的电脑需要运行 Cindy、在线并允许相应远程访问。
中国大陆版，独立 Bundle ID `com.chengfei.quotacat.cn`。

## 使用

打开「猫猫.app」，用与远端电脑相同的 Cindy 账号登录。企业 SSO 默认标识为 `xd`，可修改。
登录后直接进入全部电脑的额度总览；Claude 排在 ChatGPT 前面，5 小时与每周额度并排显示。
电脑筛选、模型专项额度、重置时间均可直接查看。相同订阅在不同电脑共享额度，不作相加。

关闭窗口会保留菜单栏猫猫图标，点击即可再次打开；右键菜单可刷新或退出应用。
窗口打开时每 30 秒刷新，隐藏后停止定时刷新，再次打开立即刷新。未启用系统通知或自动启动。
离线、远程连接未开放和读取失败分别显示，不把失败当成 0%。超过重置时间的旧额度显示等待刷新。
两端额度列表均排除 `quota-cat-` 身份的猫猫 Mac 查看端；真实电脑仍保留离线／未开放状态，
不会因为电脑恰好也叫「猫猫 Mac」而隐藏。
设备筛选会按登录账号记住，重启后恢复所选电脑或「全部电脑」。离线电脑保留选中状态，
已从目录移除的电脑回到全部。100% 余量但来源未给重置时间时明确显示当前未使用、未返回时间，
不据此断言计时已启动或补造五小时后的时间。

支持企业入口选择、SSO 账号选择、SSO 追加验证码，以及手机号／邮箱验证码登录。
人机验证与额外手机号／邮箱绑定暂不支持，服务端要求时会提示；需要先在 Cindy 完成绑定。
企业授权使用系统浏览器，PKCE verifier 与独立轮询密钥只在主进程内存中保存，取消／超时丢弃迟到结果。

## 开发与构建

在仓库根目录安装依赖后：

```sh
pnpm --dir apps/remote-mac-usage start
pnpm --dir apps/remote-mac-usage demo
pnpm --dir apps/remote-mac-usage test
pnpm --dir apps/remote-mac-usage typecheck
pnpm --dir apps/remote-mac-usage verify:ui
pnpm --dir apps/remote-mac-usage package
```

构建脚本显式传入 `--region cn`，输出到 `dist/`。独立 Electron 外壳只打包额度客户端，
不打包 Cindy 主应用、Agent 二进制或数据库。构建依赖与仓库现有版本一致。

`package` 生成当前 Mac 架构的 `.app` 和 ZIP，使用本机 Developer ID Application 证书，
启用 hardened runtime 和 Electron fuses，严格校验签名后重新压缩。没有合适证书时拒绝交付未签名包。
不做 Apple 公证。输出为 `out/quota-cat-cn-<arch>-developer-id.zip`，旁边 JSON 记录签名身份与 SHA256。

## 数据与协议边界

- 登录状态：`~/Library/Application Support/QuotaCatCN/session.enc`，由 Electron `safeStorage`
  加密，钥匙串身份为 `QuotaCatCN Safe Storage`；不可用时不降级明文。串行原子写入，退出登录删除，
  解密失败保留原文件并提示。设备随机标识存同目录 `device-id`。
- 设备筛选：同目录 `view.json`，仅含账号归属 ID 与所选设备 ID，串行原子写入，
  退出登录清除，不保存令牌、额度数值或电脑名称，不跨账号恢复。
- 不读取 Cindy 的 userData、登录文件或 Claude / ChatGPT 凭证。Renderer 不接收 token 或授权 ticket。
  只暴露固定登录／查看命令，Main 校验参数和窗口来源；页面无 Node、无网络能力，导航和下载关闭。
- 复用 `@cindy/auth-client`、`@cindy/device-link` 与共享 Codex 限额桶选择逻辑，不修改协议或服务端。
  额度查询仅使用 `maker:provider:list`、`maker:usage:claude-subscription`、`maker:usage:codex-rate-limits`。
  独立账号必须收到匹配的 providerId；旧端忽略账号参数时不借用默认账号额度。
- 使用既有后台 link 能力，远端未确认支持时关闭该 peer 并提示更新，不降级为前台控制。
  这里的只读是客户端功能范围，Cindy 登录本身不等于服务端签发了只读权限。
- 故障半径：单账号失败仅影响该账号；单电脑失败不重启共享 relay，不影响其他电脑；
  退出／换登录身份才停止整个客户端。传输重连复用既有 DeviceLinkClient，不重放写操作。
- 不持久化额度历史、日志或完整网络响应。演示使用虚构数据；`--demo` 使用独立临时 profile，退出后回收。

## 验证记录（2026-10-30）

- 定向单测覆盖登录与存储、查看端过滤，以及菜单栏奇数尺寸产生半像素坐标的回归；类型检查与构建通过。
- 实际 Electron 窗口：浅色／深色、468px／390px 截图与文字对比度检查通过；
  筛选、展开、键盘焦点、演示进入／退出和隐藏／复用窗口通过。证据生成于忽略目录 `qa/`。
- Developer ID 签名正式包已在本机启动，实际窗口已显示同账号多台电脑上的 Claude / ChatGPT 真实额度。
  登录由用户完成；已正常退出 0.1.0 后启动 0.1.1，原登录自动恢复，并重新读取真实额度。
- 0.1.3 已实机选择 M5 电脑、完整退出并重新打开，恢复原登录和 M5 筛选；菜单栏定位路径也已实测。
- Gatekeeper 评估结果为 `Unnotarized Developer ID`：签名有效，但未做 Apple 公证，因此系统仍可能要求 Open Anyway。
- `xd` 的 desktop SSO 发现请求已实测返回「心动公司」、一个入口、`cn` 区域。
- 提交工作区的全仓 `check:test-hygiene` 被既有 `newMakerDraft.test.ts` 阻断（56 次 resetModules，
  基线允许 54）；本次未修改该测试或基线。两端独立 App 的定向测试与类型检查通过。
- 当前界面为中文，未实现五语言；不影响原 Cindy 的界面或语言配置。

猫咪图标复用本仓 iOS 独立 App 的原创 SVG（`apps/remote-ios-usage/assets/icon.svg`，
源 blob `852bf2f5e8726ad1efc8eae38e82f6056472ef08`）。两端保留相同的独立资源副本。
