# 猫猫 iOS

独立的 iOS 订阅用量客户端，默认连接中国大陆 Cindy。独立 Bundle ID：
`com.chengfei.remoteiosusage`，不依赖原版应用组、推送或分享扩展，也不修改原版 Mobile。

## 运行

仓库根目录安装依赖后：

```sh
pnpm --dir apps/remote-ios-usage start
pnpm --dir apps/remote-ios-usage ios -- --configuration Release --device
pnpm --dir apps/remote-ios-usage typecheck
pnpm --dir apps/remote-ios-usage exec expo export --platform ios
```

首次真机签名在 Xcode 中选择自己的开发团队。独立 App 仍需要自己的开发签名，不代表已获得苹果分发资格。
不要复用 Cindy 原版的 Bundle ID 或 provisioning profile。2026-10-30 已使用本机 Apple Development 团队构建 Release 0.1.0（8），覆盖安装到配对 iPhone 并成功启动；系统应用列表已核对显示名称为「猫猫」、构建号为 8。

## 页面

- 登录：默认企业标识 `xd` 的企业 SSO，及手机号／邮箱验证码；支持账号选择和 SSO 额外验证码。
- SSO 使用系统浏览器与既有托管回调、PKCE、独立轮询密钥；取消和五分钟超时均清理本次授权，不接收迟到凭证。企业域名可编辑。
- 设备列表：显示同账号电脑，离线或关闭远程连接的电脑不可进入。
- 用量总览：每个 Claude / ChatGPT 账号一张卡，5 小时与 7 天配额并排展示。
- 详情：各周期及模型专项配额、重置时间。过期值显示等待刷新，不假定重置到 100%。
- 「先看看界面」进入明确标注的虚构演示模式，不访问服务端。

## 连接与边界

使用 `@cindy/auth-client`、`@cindy/device-link` 既有协议和中国大陆公开端点。
仅调用 `maker:provider:list`、`maker:usage:claude-subscription` 和 `maker:usage:codex-rate-limits`，按连接 ID 校验独立账号。
界面只提供只读功能，不代表服务端为这个客户端颁发了只读权限。

登录令牌与设备标识存系统 SecureStore（iOS 钥匙串）；不读取 Claude 凭证，不记录请求内容和凭证。
启动先恢复本机登录，直接进入设备首页，再刷新令牌和设备列表。网络失败保留登录；明确的刷新凭证失效才清除。
返回仅切换页面，明确退出登录才删除钥匙串中的登录记录。页面前台每 30 秒读取，失败明确提示。
支持 Claude、ChatGPT，未接 Grok。验证码人机验证和额外绑定流程暂不支持；
服务端要求这些步骤时显示错误，不绕过验证。用户已提供真实设备的配额页面截图；账号密码由用户自行输入，自动化测试使用虚构数据。

目前界面为中文个人原型，深浅色均实现；尚未提供多语言。浅色组件窄屏预览与用户真机截图已检查，深色原生界面未完整目检。

SSO 检查：xd 已识别为心动公司；mobile 授权请求被现网接受并返回心动 SSO 域名。实际企业密码登录需由用户在手机完成。

## 返回与登录态

设备首页显示「退出登录」，设备用量和账号详情仅显示「返回」「刷新」。
左侧 28pt 边缘右滑可返回上一页，纵向滑动不接管；超过屏宽 30% 或明确向右快速滑动才返回，
否则回弹。首页不响应返回手势，返回不退出登录，支持减少动态效果。

账号总览按 Claude / Anthropic 在前、ChatGPT / OpenAI 在后排列，同类保持电脑原有顺序。
原创图标的可编辑源为 `assets/icon.svg`，`assets/icon.png` 为 iOS 图标资源。

0.1.0（7）：系统显示名称与登录页名称改为「猫猫」，Bundle ID 和钥匙串键保持不变，
以覆盖安装保留原 App 数据。设备列表按 `quota-cat-` 设备身份排除猫猫 Mac 查看端，
不按名称判断，也不隐藏真正离线或未开放远程连接的电脑。

0.1.0（8）：记住最后停留的设备，冷启动恢复登录后先核对设备列表，再进入该设备的用量页；
从账号详情返回仍记住这台设备，显式返回设备首页则记住首页。设备离线、被移除、未开放远程
连接或暂时无法读取时回到首页并说明原因，不在后台刷新后突然跳页。演示模式不写真实记录。
偏好键 `usage-cn-last-device-v1` 只存所属账号 ID 与设备 ID，放在本机 SecureStore，退出登录清除，
不跨账号恢复。旧版未记录过停留位置，升级后首次仍进入首页，从新版选过设备后开始记忆。

## 验证

```sh
pnpm exec vitest run apps/remote-ios-usage/src --config apps/mobile/vitest.config.ts
pnpm --dir apps/remote-ios-usage exec tsc --noEmit
```

定向测试覆盖账号配额作用域、登录恢复与刷新失败、退出后的迟到结果、SSO PKCE 与取消、
各层级导航和边缘手势。真实原生构建、签名及安装不由这些单元测试替代。
