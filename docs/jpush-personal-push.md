# 个人构建的极光 iOS 推送

适用于维护者自己的 Desktop 与 iOS 安装包。默认关闭；不改变官方推送服务端，也不把
APNs 私钥或极光 Master Secret 打入客户端资源。Android 保持现有实现。

## 范围与链路

- iOS 使用 JPush 6.2.7，持有公开 AppKey；APNs Auth Key 由维护者在极光控制台配置。
- 手机启用通知后获得随机别名，经同账号 device-link 连接分别登记到在线电脑。
  电脑通过极光 HTTP API 按别名发送，不使用广播。两台电脑各自需要配置发送凭证。
- 覆盖已有桌面通知出口：任务完成、失败、等待回复，以及桌面伙伴群分工提醒。
  保留原来的任务静音、阅读抑制、事件去重和点击深链。
- Chat Server 主动发出的云端消息不经过桌面，此接入不能替它更换推送凭证。

## 配置 iOS

在极光控制台创建应用，iOS 页面选择 Token Authentication，上传该 Apple 团队的
APNs `.p8`，填写 Key ID、Team ID 和自己的 Bundle ID。建议使用限定 Topic 的 Key。
环境必须与实际 provisioning profile 的 `aps-environment` 一致，不能按 Debug/Release
或 `__DEV__` 猜。开发签名的 Release 包也可能使用 Sandbox。

构建时显式注入公开配置，再走既有 iOS 本地构建流程：

```bash
export EXPO_PUBLIC_CINDY_AUTH_REGION=cn
export CINDY_USE_LOCAL_REGION_CONFIG=1
export CINDY_JPUSH_APP_KEY='<自己的 AppKey>'
export CINDY_JPUSH_APNS_ENV=sandbox
```

`production` 仅用于生产签名及对应的生产推送密钥。不要把 Master Secret 放入这些
环境变量、Expo extra、源码、仓库内的 `.env` 或地区配置文件。

主 App 与 `CindyNotificationService` 必须签入同一个 `group.<Bundle ID>` App Group。
config plugin 会生成相应声明，但 Apple 后台的 App ID / profile 也要具备对应能力。
没有共享目录时启用失败，不静默退化成无法保护预览的推送。

原生模块、SDK 与通知扩展改变 runtime fingerprint，必须重建安装，不能只做 OTA。
旧原生包运行新 JS 时模块缺席，继续使用原通道；未设置 AppKey 的新包不启动 JPush。
如将此改动提交正式 PR，仍需遵守冷更合并门。

## 配置两台 Desktop

每台电脑运行以下交互工具；Master Secret 在终端隐藏输入，不进入命令行历史：

```bash
python3 scripts/configure-jpush.py --app-key '<自己的 AppKey>'
```

工具在操作系统临时目录创建权限为 0600 的一次性导入文件，并打印
`--jpush-config=/绝对路径/cindy-jpush-import-….json`。完全退出新版 Cindy 后，以这个
参数打开它；macOS 可以使用 `open -a /Applications/Cindy.app --args` 加该参数。
开发模式可用 `CINDY_JPUSH_CONFIG_FILE=/绝对路径/文件.json` 配合仓库的
`pnpm restart:desktop:remote --region=cn`。不要把真实凭证文件放在 checkout 内。

导入只在云账号就绪后执行，并绑定届时登录的账号。高级手工导入可指定 `ownerId`
要求精确匹配；配置字段为 `appKey`、`masterSecret`、可选 `ownerId`。
成功后凭证进入现有 owner-scoped Electron safeStorage，工具创建的临时文件自动删除。
若未运行或导入失败，临时文件仍在，请自行删除或修正后重新导入。切换账号不继承凭证。
配置没有 Renderer、Agent 或远程读取入口。另一台电脑需要独立配置，不自动同步 Master Secret。

手机登录同一个账号并打开「通知」后，保持前台让它与在线电脑同步；另一台休眠时，
待其上线并让手机回到前台同步。每分钟补登记，登记超过 30 天未续期的电脑记录不再发送。
旧桌面返回 channel-not-allowed，不扩大重连范围；手机本身登记成功不代表某台电脑已配置。

## 账号、预览和失败语义

- 每次账号或预览模式变化先关闭本机显示门，再撤销旧别名，成功后生成新别名。
  SecureStore 保存随机别名与待撤销标记，失败后重启仍可补偿。
- 退出、关闭通知时先清除 App Group 的显示门，再异步解绑。网络清理失败不阻止退出。
  离线时仍可能到达此前已发出的通用提醒，不能声称能撤回 Apple 已接受的通知。
- 外层 APNs alert 只有 Cindy 和通用事件文案；正文放在 JPush extras 中。通知扩展核对
  本机当前别名且预览开启后才展开正文，扩展超时或文件不可读均回退通用提醒。
  关闭预览时发送端不包含正文和头像。旧别名的通知点击不会打开新账号的任务。
- extras 并非端到端加密，极光作为代发方可以处理预览开启时提交的正文；不应把该保护
  说成极光无法读取内容。预览关闭时也仍需发送用于导航的任务/设备标识。
- HTTP 失败仅记录固定错误说明，不记录正文、别名、鉴权头或服务商响应正文。
  采用短 TTL，不对不确定结果自动重复投递。返回本机已接受不代表 APNs 或手机已送达。

## 验证入口

```bash
pnpm --dir apps/mobile exec vitest run src/__tests__/jpushLifecycle.test.ts src/__tests__/pushNotificationsRealm.test.ts src/__tests__/communicationNotificationsPlugin.test.ts
pnpm --dir apps/desktop exec vitest run src/main/device-link/__tests__/jpush.test.ts src/main/device-link/__tests__/mobileNotify.test.ts src/main/__tests__/deviceLinkDispatch.test.ts
pnpm --dir apps/mobile typecheck
pnpm --dir apps/desktop typecheck
```

真机仍需扩展验证：冷启动点击、退出/换账号、离线关闭预览、
两台电脑交替上线、原生扩展异常时的通用提醒。单测和原生模块编译不能代替这些检查。

2026-11-04 本机验证：Mobile 52 项、Desktop 160 项定向测试通过，原生模块的
Release/iphoneos 无签名编译及通知扩展 Swift 类型检查通过。新增生命周期测试文件
单独运行约 1.8s，宿主登记测试约 1.1s；Mobile 同域合跑约 2.2s。发送端测试单文件约 0.7s，
凭证边界测试约 0.9s；既有大型 dispatch 文件与同域合跑约 7.5s，耗时主要为依赖加载。
CI fingerprint 口径的 iOS 与 Android 均发生变化（共享 plugin 输入也影响 Android 指纹），
不承诺 Android 可以沿用旧 runtime。生产自建中转互通尚未验收；APNs 实测见下方补充记录。
全仓 `check:test-hygiene` 在未改动的 `newMakerDraft.test.ts` 报告 `resetModules`
56 次、基线允许 54 次，本次不修改该文件或基线。

同日补充安装验证：Mac Developer ID 签名包已安装并通过严格签名校验；一次性发送凭证
成功导入加密存储后，临时明文文件已删除。iOS 完整 Release 构建、主 App 与三个扩展的
签名和 App Group 权限核验通过，Sandbox 新包已覆盖安装到真机。通知扩展移除误加的
communication entitlement，主 App 保留；对应插件用例先复现再修复，通知相关 23 项测试通过。
同日真机投递验收：极光后台对单台 iOS 开发环境设备的定向通知已收到；随后本机 Mac
任务完成触发的极光推送已收到，点击能打开对应测试任务，由手机持有人确认。
排查时曾只有空的接收登记表；重启手机 App 后完整登记才同步到 Mac。不能仅凭
`jpush_registrations.enc` 存在就认定登记成功，首次注册后的同步时序仍需追加回归。
Mac 的任务通知在窗口聚焦时有意抑制，后台验收须先切走焦点。临时 Debug 日志已恢复关闭。
第二台电脑与上述生命周期场景未验收，不能将本次单机成功泛化为全部通过。

并行开发时不要同时生成同一份 `ios/` 工程：不带个人推送环境变量的 prebuild 会覆盖
极光配置。安装前必须检查最终 `.app/Info.plist` 的三个 `CindyJPush*` 字段、APNs 环境，
以及主 App 和通知扩展的实际签名与 provisioning profile 中的 App Group，不能只检查源码配置。

接口来源：[极光 iOS SDK](https://docs.jiguang.cn/jpush/client/iOS/ios_api)、
[推送 HTTP API](https://docs.jiguang.cn/jpush/server/push/rest_api_v3_push)。
