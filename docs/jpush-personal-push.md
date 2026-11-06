# 个人构建的极光 iOS 推送

适用于维护者自己的 Desktop 与 iOS 安装包。默认关闭；不改变官方推送服务端，也不把
APNs 私钥或极光 Master Secret 打入客户端资源。Android 保持现有实现。

## 新设备先看这里

教程核对日期：2026-11-06。默认中国大陆版、个人自用；命令中的尖括号内容必须替换。

| 场景 | 要做什么 | 不需要重复做什么 |
| --- | --- | --- |
| 新 Mac，继续用现有 iPhone | 安装支持个人极光推送的 Cindy，按下文导入发送凭证，再让手机前台登记 | 不用重新创建极光应用或 Apple APNs Key |
| 新 iPhone，电脑已配好 | 安装同一 Bundle ID、带极光配置且签名允许这台手机的个人版，登录同一账号并开启通知 | 手机不填写 Master Secret；电脑不因换手机而重新导入发送凭证 |
| 重建／覆盖 iOS 包 | 保留构建环境中的 AppKey 和 APNs 环境，检查最终包及签名后安装 | 不要只检查源码里是否有极光模块 |
| 切换 Cindy 账号 | 用目标账号重新配置电脑并完成手机登记 | 原账号的加密配置不会自动继承 |

完成标准是：**新电脑已配置 + 手机完成登记 + 手机后台实际收到该电脑任务完成通知**。
只有文件存在、构建成功或极光接受请求，均不算全部验收通过。

## Key 在哪里拿、分别保存在哪里

先登录[极光控制台](https://www.jiguang.cn/console/)，选择给个人版 Cindy 建的那一个应用，
核对 iOS Bundle ID 与实际安装包一致，再进入「应用设置」查看 AppKey 和 Master Secret。
控制台入口名称若调整，以该应用的设置／密钥页面为准。已有应用直接复用，不要每换一台设备
就创建新应用；取值时用「查看」，不要误点「重置」。

| 名称 | 从哪里获取 | 用在哪里、怎么存 |
| --- | --- | --- |
| 极光 AppKey | 极光应用设置 | 公开应用标识。电脑导入时填写，iOS 构建时注入。可存本机忽略的构建配置；本教程不写个人真实值 |
| 极光 Master Secret | **同一个**极光应用的设置页面 | 发送凭证。只在每台电脑的导入工具隐藏输入，随后由 Cindy 存入系统加密存储；可在个人密码管理器保留一份加密备份 |
| Apple APNs Auth Key（`.p8`） | [Apple Developer](https://developer.apple.com/account/) → Certificates, Identifiers & Profiles → Keys；首次创建时启用 APNs 并下载 | 只上传到极光的 iOS Token Authentication 配置；原文件另存在仓库外的加密保险库。Apple 只允许下载一次，已上传且有效时无需重建 |
| Apple Key ID / Team ID / Bundle ID | Key 详情、开发者团队资料、应用 App ID | 与 `.p8` 一起填到极光。它们是标识，不是 Master Secret，也不是手机 Device Token |
| 手机别名／接收登记 | App 自动生成并同步 | 不手填、不复制到新手机；登录与通知开关控制其生命周期 |

极光 AppKey / Master Secret 的用途见[官方概念说明](https://docs.jiguang.cn/jpush/intro/concept)，
Apple Key 的获取及极光上传步骤见[官方 iOS 证书设置指南](https://docs.jiguang.cn/jpush/client/iOS/ios_cer_guide)。

**密钥保存规则：**不要把 Master Secret 或 `.p8` 放进仓库、`.env`、安装包、聊天、截图或 shell
命令参数。不要复制旧 Mac 的 `.enc` 文件到新 Mac：它受原电脑系统加密机制和 Cindy 账号范围约束，
新机应重新走导入。换电脑不需要重置极光密钥；若确实泄露并重置了 Master Secret，则所有发送电脑都要重新导入。

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

以上变量要在 **prebuild、原生编译和 JS 打包的同一构建流程**中保持有效，避免中途被另一套脚本覆盖。
也可将下面三个非秘密变量维护在本机 `apps/mobile/.env` 中（已有键就修改，不重复追加）：

```dotenv
EXPO_PUBLIC_CINDY_AUTH_REGION=cn
CINDY_JPUSH_APP_KEY=<自己的公开AppKey>
CINDY_JPUSH_APNS_ENV=sandbox
```

先用 `git check-ignore apps/mobile/.env` 确认本地文件被忽略；不要强制提交。Expo CLI 会加载 `.env`，
直接调用 `xcodebuild` 或其它脚本时仍应显式传入上面的构建环境。新构建电脑需恢复这些公开配置，
个人 Bundle ID 和签名配置按[Mobile 开发规则](dev-rules/mobile-development.md#仓库与个人配置的边界)准备。
这份 `.env` **绝不能加 Master Secret 或 APNs 私钥**。

`production` 仅用于生产签名及对应的生产推送密钥。不要把 Master Secret 放入这些
环境变量、Expo extra、源码、仓库内的 `.env` 或地区配置文件。

主 App 与 `CindyNotificationService` 必须签入同一个 `group.<Bundle ID>` App Group。
config plugin 会生成相应声明，但 Apple 后台的 App ID / profile 也要具备对应能力。
没有共享目录时启用失败，不静默退化成无法保护预览的推送。

原生模块、SDK 与通知扩展改变 runtime fingerprint，必须重建安装，不能只做 OTA。
旧原生包运行新 JS 时模块缺席，继续使用原通道；未设置 AppKey 的新包不启动 JPush。
如将此改动提交正式 PR，仍需遵守冷更合并门。

### 新 iPhone 的安装与验收

1. 使用已经验证过的个人版安装包。若使用开发签名，先在 Apple 开发者团队登记新手机，
   更新包含它的 provisioning profile，再构建签名；旧包不一定允许安装到新设备。
2. 安装前检查最终 `.app/Info.plist` 中有 `CindyJPushAppKey`、`CindyJPushProduction`、
   `CindyJPushAppGroup`，且 AppKey 与电脑导入的是同一个应用。
   `CindyJPushProduction=false` 对应签名的 `aps-environment=development`；`true` 对应 `production`。
3. 用 `codesign -d --entitlements :- '<实际路径>/Cindy.app'` 检查主 App，
   对 `Cindy.app/PlugIns/CindyNotificationService.appex` 同样检查；两者都必须有相同的
   `group.<Bundle ID>`，embedded provisioning profile 也必须允许这些能力。
4. 覆盖安装并打开，登录与电脑相同的 Cindy 账号。在 iOS 系统设置中允许该 App 的通知，
   同时开启 Cindy 内的通知开关；保持前台约一分钟，让它向在线电脑登记。
5. 按下方「实际通知验收」验证。新手机无需接触 Master Secret 或 `.p8`。

完整原生构建依赖本机 Xcode、签名团队、个人地区配置；不能把别人的临时构建脚本／路径当通用入口。
仅新增一台 Mac 时不需要重建 iOS。已有签名正确的手机包也不要为了电脑配置问题反复重装。

## 新 Mac：逐步配置发送凭证

### 1. 准备应用与账号

安装这个 fork 中支持极光推送的中国大陆版 Cindy；仅安装官方版或过旧版本不保证有本功能。
若需要自行打包、签名和替换，使用[个人打包流程](dev-rules/desktop-development.md#个人打包)。
先在 Mac 登录准备接收通知的 Cindy 账号，确认手机同账号，设备互联正常且电脑允许远程控制。
接下来退出／重启 Cindy 会中断其中运行的任务，应先等它们结束。

### 2. 在本机导入 Key

每台电脑运行以下交互工具；Master Secret 在终端隐藏输入，不进入命令行历史：

```bash
cd '<本机 cindy-feige 仓库绝对路径>'
python3 scripts/configure-jpush.py --app-key '<自己的 AppKey>'
```

出现 `JPush Master Secret（不回显）:` 后，从极光控制台或密码管理器粘贴对应 Secret，按回车。
输入时看不到字符是正常的。**不要把 Secret 接到命令后面。** 使用剪贴板粘贴后，可执行
`pbcopy < /dev/null` 清空剪贴板。

工具在操作系统临时目录创建权限为 0600 的一次性导入文件，并打印
`--jpush-config=/绝对路径/cindy-jpush-import-….json`。完全退出新版 Cindy 后，以这个
参数打开它；macOS 可以使用 `open -a /Applications/Cindy.app --args` 加该参数。

具体操作：用 Cindy 菜单「退出」或 `⌘Q` 完全退出（只关窗口不够），再运行下面命令，
路径使用工具刚刚输出的实际值，不要照抄示例占位符：

```bash
open -a /Applications/Cindy.app --args '--jpush-config=/实际路径/cindy-jpush-import-实际随机值.json'
```

重新打开后确认登录的是正确账号，等待导入。这个步骤只导入配置，不是替换应用的命令。

开发模式可用 `CINDY_JPUSH_CONFIG_FILE=/绝对路径/文件.json` 配合仓库的
`pnpm restart:desktop:remote --region=cn`。不要把真实凭证文件放在 checkout 内。

导入只在云账号就绪后执行，并绑定届时登录的账号。高级手工导入可指定 `ownerId`
要求精确匹配；配置字段为 `appKey`、`masterSecret`、可选 `ownerId`。
成功后凭证进入现有 owner-scoped Electron safeStorage，工具创建的临时文件自动删除。
若未运行或导入失败，临时文件仍在，请自行删除或修正后重新导入。切换账号不继承凭证。
配置没有 Renderer、Agent 或远程读取入口。另一台电脑需要独立配置，不自动同步 Master Secret。

### 3. 确认凭证入库，再让手机登记

中国大陆版 macOS 正式安装的默认目录是：

```text
~/Library/Application Support/Cindy/safe-storage/
  owner_<账号摘要>_jpush_config.enc          # 发送凭证，系统加密
  owner_<账号摘要>_jpush_registrations.enc   # 手机接收登记，系统加密
```

可以只检查文件名、大小和修改时间，不解密、不打印文件内容：

```bash
find "$HOME/Library/Application Support/Cindy/safe-storage" -maxdepth 1 -name '*jpush*.enc' -exec ls -lT {} \;
```

先确认 `jpush_config.enc` 存在且本次临时导入文件已自动删除。若临时文件还在，导入可能没成功：
检查是否完全退出旧进程、启动参数路径、当前账号及应用版本；确认不再使用时只删除该**确切临时文件**，
不要批量删除整个临时目录，也不要将它转存进仓库。

手机登录同一个账号并打开「通知」后，保持前台让它与在线电脑同步；另一台休眠时，
待其上线并让手机回到前台同步。每分钟补登记，登记超过 30 天未续期的电脑记录不再发送。
旧桌面返回 channel-not-allowed，不扩大重连范围；手机本身登记成功不代表某台电脑已配置。

打开手机上的 Cindy、开启通知、保持前台至少一分钟，然后再次检查文件。接收登记应出现／更新；
但空登记表也会生成文件，因此文件存在只是中间信号，必须继续实测。

### 4. 实际通知验收

1. 手机先在前台完成登记，再回到主屏幕，把 Cindy 留在后台；不要在手机里看着待测任务。
2. 在待验收的那台 Mac 发一个简单任务，例如要求只回复一句测试文字。
3. 任务完成前切到其它应用，让 Mac 的 Cindy 失去焦点。确保该任务没开免打扰。
4. 等手机收到完成通知，点击确认能打开对应任务。每台新 Mac 单独验收一次。

建议测试本机执行的普通任务，避免其它电脑的执行／转发链路混入排查。
手机在后台不需要一直保持设备互联在线；电脑需要能访问极光 API，且保存着有效接收登记。

## 常见问题：按顺序检查

| 现象 | 下一步 |
| --- | --- |
| 没有 `jpush_config.enc` | 检查本机是否导入、当前账号是否正确、是否运行支持极光的 Cindy；其它电脑配置成功不代表本机已配置 |
| 有配置但没有接收登记 | 手机开启通知并回前台，确认能看到这台在线电脑；仍无登记时核对 iOS **最终包**的极光字段，再检查绑定／连接错误 |
| 更新 iOS 包后突然不登记 | 优先检查打包是否遗漏 `CINDY_JPUSH_APP_KEY`／`CINDY_JPUSH_APNS_ENV`；不能靠只手改生成的 `ios/Cindy/Info.plist` 长期保留配置 |
| 有登记但不弹通知 | 手机切后台、电脑切走焦点、任务关闭免打扰；再检查 iOS 通知权限、专注模式与通知摘要 |
| 日志出现 `mobile push delivery failed` | 已进入发送阶段；新版安全诊断会给出 HTTP／极光数字错误码或固定网络错误码。旧版只有泛化错误，不能仅据此判断根因 |
| `JPUSH_HTTP_401_CODE_1004` | 极光鉴权失败：核对 AppKey 与 Master Secret 是否来自同一个应用、Secret 是否已重置；用导入工具重新配置，不在日志中粘贴密钥 |
| `ENOTFOUND` / `TIMEOUT` 等 | 检查电脑访问极光 API 的 DNS／网络；只读探测不携带密钥，不能将受限执行环境里的失败直接当作 Cindy 本身网络故障 |
| 极光显示接受，但手机没收到 | 继续核对别名有效性、APNs 环境、Apple 推送配置和系统通知状态；接口接受不等于手机送达 |

主日志位于 `~/Library/Application Support/Cindy/logs/main-YYYY-MM-DD.log`。只筛选必要诊断行：

```bash
rg 'device-link:jpush|mobile push' "$HOME/Library/Application Support/Cindy/logs/main-$(date +%F).log"
```

没有错误日志也不代表成功：事件可能被免打扰／阅读状态抑制，或者根本没有有效登记。
本教程不要求将全部日志、加密凭证文件或 Apple 私钥发到聊天中。

2026-11-06 实测记录：一次重建的 iOS 包缺少极光配置，补齐并覆盖后手机接收登记恢复；
随后仍发生过发送失败，安装带安全错误码诊断的 Mac 包并重启后，手机持有人确认收到了
任务完成通知。旧失败日志没有具体错误码，不能把最后一次成功归因为某个已证实的发送端修复。

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
