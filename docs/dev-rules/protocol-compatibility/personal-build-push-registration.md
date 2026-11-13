# 个人构建的可选推送登记

`device-link:jpush:registration:v1` 仅在通用 invoke 中增加可选通道，不改变 envelope、
notify 或 relay capability。同账号设备只能登记/删除自己 `env.src` 对应的随机别名，
共享任务访客、供应商分享对端、撤销设备及关闭远控时拒绝。Master Secret 不在协议中。
旧 Desktop 不支持该 channel 时保留其正常错误，手机不重置全局连接；自建中转只需沿用
已有同账号 invoke 转发，不增加推送服务端能力。两端适配及验证见
[个人极光推送](../../jpush-personal-push.md)。
