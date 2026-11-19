/**
 * 错误告警的「已处置」ack。
 *
 * 这是用户对横幅执行操作（重试、继续、关闭）的路径。普通本机错误在查看时
 * 可以清除提醒，见 usePendingAlertAttention，横幅仍由自己的恢复流程管理。
 *
 * 落库型处置(中断 ack、错误尾行 dismiss)不走这里:它们改变的是 pending-alerts
 * 查询的结果,由 usePendingAlertAttention 的差分收敛清点。本函数服务的是
 * makerChatStore 内存态 live error 那条腿 —— 它没有持久真源可派生,必须显式清。
 *
 * live ErrorBanner 的「关闭 / 重试」会 dispose 同一 persistId(清内存态并尽快把
 * 即将/已经落库的 error 行标 dismissed),所以同一视图不会再补弹尾部错误。未点
 * 就离开再回来,仍可看到持久化卡 —— 点过才算处置。关闭时仍清除任何剩余提醒;
 * 新的终止错误会由 useSessionRunningStatus 重新打点。
 */

import { clearSessionAttention } from './sessionAttentionStore';

/**
 * 用户已处置该会话的错误告警:以 explicit 意图清红角标(passive 清除对 error 免疫)。
 * 幂等。store 对 explicit 清除保证把意图经 notification:clear-session-attention 桥接
 * 到灵动岛 / Dock 角标,本地没有条目(如 renderer 曾重载)时同样照发。
 *
 * 远程会话据此按 explicit-action 放行回执(不卡对账新鲜度门槛):用户都动手处置了,
 * 目标会话的内容显然已被看到。
 */
export function ackErrorAlertHandled(sessionId: string): void {
  clearSessionAttention(sessionId, { intent: 'explicit' });
}
