# 猫猫 Mac

> 2026-11-05：已移除 Cursor 额度入口，保留 Claude / ChatGPT 账号、登录和设备筛选。下方 Cursor 验证条目为旧版本记录。

独立的 macOS 菜单栏应用，直接查看同一 Cindy 账号下各台电脑的 Claude / ChatGPT / Cursor 订阅额度。当前版本 0.1.8。
当前 Mac 不需要运行 Cindy；提供额度的电脑需要运行 Cindy、在线并允许相应远程访问。
中国大陆版，独立 Bundle ID `com.chengfei.quotacat.cn`。

## 使用

打开「猫猫.app」，用与远端电脑相同的 Cindy 账号登录。企业 SSO 默认标识为 `xd`，可修改。
登录后直接进入全部电脑的额度总览；订阅固定按 Claude → OpenAI（ChatGPT）→ Cursor 排序；Claude / ChatGPT 的 5 小时与每周额度并排显示。
Cursor 使用独立双池卡片：Cursor 模型、其他模型分别显示剩余／已用百分比与重置日期，不能相加或用最低值代表整个账号；只有总额度时明确显示汇总，缺失池显示未知。保留一位小数，非零的极小用量显示为 `<0.1%`，接近满额显示为 `>99.9%`，不把少量消耗四舍五入成从未使用。额外付费状态不作推测。
电脑筛选、模型专项额度、重置时间均可直接查看。相同订阅在不同电脑共享额度，不作相加。

关闭窗口会保留菜单栏猫猫图标，点击即可再次打开；右键菜单可刷新或退出应用。
窗口显示时再次单击图标隐藏，不依赖点击时的焦点状态；窗口隐藏或已最小化时，点击图标恢复并唤到前台。
点击窗口外使其失焦时自动收起；点击菜单栏图标仍按显隐切换。双击最终保持窗口打开。唤起复用现有页面并先显示，再异步刷新额度。
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
- 复用 `@cindy/auth-client`、`@cindy/device-link` 与共享 Codex 限额桶选择逻辑，沿用现有加密 invoke 协议，不修改服务端或中转。
  额度查询仅使用 `maker:provider:list`、`maker:usage:claude-subscription`、`maker:usage:codex-rate-limits`。
  Cursor 通道要求新版 Cindy；旧端返回不支持时明确提示更新。
  独立账号必须收到匹配的 providerId；旧端忽略账号参数时不借用默认账号额度。
- 使用既有后台 link 能力，远端未确认支持时关闭该 peer 并提示更新，不降级为前台控制。
  这里的只读是客户端功能范围，Cindy 登录本身不等于服务端签发了只读权限。
- 故障半径：单账号失败仅影响该账号；单电脑失败不重启共享 relay，不影响其他电脑；
  退出／换登录身份才停止整个客户端。传输重连复用既有 DeviceLinkClient，不重放写操作。
- 不持久化额度历史、日志或完整网络响应。演示使用虚构数据；`--demo` 使用独立临时 profile，退出后回收。

## 验证记录

- 2026-11-04 / 0.1.8：独立猫猫新增 Cursor 双池卡片，固定 Claude → OpenAI → Cursor 排序。
  同账号只读查询不开放 Cursor 远程执行；旧 Host 显示更新提示，失败与未知不当零。
  31 项单测、类型检查、13 项 Electron UI 检查通过，覆盖深浅色／390px 窄窗、对比度与交互。
  已在签名安装版保留原登录与设备筛选，通过实际 Device Link 读取真实 Cursor 两池数据；
  已核对最终窗口的两池名称、剩余／已用、重置日期和排序。实测发现并修复小于 1% 的消耗被整数舍入隐藏的问题。


- 2026-11-02 / 0.1.6：窗口失焦后自动收起，菜单栏图标上的点击交由显隐切换处理；
  延后到原生焦点／最小化状态更新后判定，避免打断最小化。类型检查、29 项单测及
  12 项 Electron 检查通过；回归覆盖窗口外失焦、图标点击前失焦和最小化恢复。

- 2026-11-02 / 0.1.5：按用户要求，窗口可见时单击菜单栏图标即隐藏，包括点击时已失焦的情况；
  替代 0.1.4 的失焦窗口唤起规则。29 项单测、类型检查与 12 项 Electron 检查通过，
  显隐回归使用真实窗口和生产 Tray handler，不再注入焦点判据。
- 2026-10-31 / 0.1.4：旧版已复现后台可见窗口首次托盘点击反而隐藏；修复后通过同一
  真实 Tray handler 回归，并覆盖隐藏恢复、双击与 macOS 最小化恢复。前台隐藏分支的自动化
  检查注入焦点判据，其余显隐及最小化使用真实窗口；没有将测试入口加入打包应用。
- 0.1.4：29 项单测、类型检查及 12 项 Electron 检查通过（含原有深浅色截图和对比度检查）。

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
