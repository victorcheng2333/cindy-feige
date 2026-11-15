/**
 * 本机刚发出的用户气泡入场一次（DESIGN.md §14.4「Desktop local send entrance」）。
 *
 * 只认这台电脑 composer 发出的消息：发送时登记时刻，气泡第一次挂载且仍在新鲜窗口内
 * 才播放；播过即记下，之后滚回、重挂载、从待落库换成正式消息都不再重播。IM、手机、
 * 定时任务等外部入口注入的消息不登记，保持静止。
 */

/** 发送到气泡首帧的正常延迟远小于此；超时的挂载（滚回来、切任务）保持静止。 */
const FRESH_MS = 1_500;
const MAX_REMEMBERED = 100;

const sentAt = new Map<string, number>();
const played = new Set<string>();

function remember<T>(collection: Map<string, T> | Set<string>, key: string): void {
  if (collection.size <= MAX_REMEMBERED) return;
  const oldest = collection.keys().next().value;
  if (oldest !== undefined && oldest !== key) collection.delete(oldest);
}

export function noteLocalSendEntrance(clientId: string, now = performance.now()): void {
  sentAt.delete(clientId);
  sentAt.set(clientId, now);
  remember(sentAt, clientId);
}

export function shouldPlayLocalSendEntrance(
  clientId: string | null | undefined,
  now = performance.now(),
): boolean {
  if (!clientId || played.has(clientId)) return false;
  const at = sentAt.get(clientId);
  return at !== undefined && now - at < FRESH_MS;
}

export function markLocalSendEntrancePlayed(clientId: string): void {
  played.add(clientId);
  remember(played, clientId);
}
