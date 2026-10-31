/** 会话搜索 / 消息深链共用的消息定位意图。 */
export interface ConversationSearchJump {
  kind: 'conversation-search';
  sessionId: string;
  messageId: string;
  messageIdKind?: 'id' | 'clientId';
  messageClientId: string;
  /** External message links locate the reply without the search-result emphasis. */
  highlight?: boolean;
}

/** 跨路由、tab 持久化和 RSB 子窗口 IPC 共用的运行时归一化。 */
export function parseConversationSearchJump(raw: unknown): ConversationSearchJump | null {
  if (!raw || typeof raw !== 'object') return null;
  const candidate = raw as {
    kind?: unknown;
    sessionId?: unknown;
    messageId?: unknown;
    messageIdKind?: unknown;
    messageClientId?: unknown;
    highlight?: unknown;
  };
  if (candidate.kind !== 'conversation-search') return null;
  if (typeof candidate.sessionId !== 'string' || !candidate.sessionId) return null;
  if (typeof candidate.messageId !== 'string' || !candidate.messageId) return null;
  if (typeof candidate.messageClientId !== 'string' || !candidate.messageClientId) return null;
  return {
    kind: 'conversation-search',
    sessionId: candidate.sessionId,
    messageId: candidate.messageId,
    messageIdKind: candidate.messageIdKind === 'clientId' ? 'clientId' : 'id',
    messageClientId: candidate.messageClientId,
    ...(typeof candidate.highlight === 'boolean' ? { highlight: candidate.highlight } : {}),
  };
}
