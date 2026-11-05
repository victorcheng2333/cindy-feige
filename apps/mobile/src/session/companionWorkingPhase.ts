import { isCompactingWorkingStatus, publicToolPhase, publicToolResultPhase, type PlainAgentPhase, type WorkingPhase } from '@cindy/maker-shared';
import { parseMessageToolUse, messageContentToPreview } from '@cindy/maker-shared/message-normalize';
import { isSubagentParentToolUseId } from '@cindy/maker-shared/message-render';
import type { RemoteMessage } from './types';

/** Ordinary tasks use live events, not completed reply text, for their caption. */
export function taskWorkingPhase(status: string, messages: readonly RemoteMessage[], startedAt: number | null): PlainAgentPhase {
  const normalized = status.trim().replace(/(?:\.{3}|…)$/, '').trim().toLowerCase();
  if (normalized === 'waiting on approval') return 'waiting-approval';
  if (normalized === 'waiting on input') return 'waiting-input';
  if (isCompactingWorkingStatus(status)) return 'compacting';
  let thinking = false;
  let resultToolId: string | null = null;
  let sawResult = false;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message.systemCardType || message.agentMeta?.turnScope === 'background'
      || typeof message.agentMeta?.parentToolUseId === 'string' && isSubagentParentToolUseId(message.agentMeta.parentToolUseId)) continue;
    if (message.role === 'user' && message.agentMeta?.delivery !== 'steer' && message.agentMeta?.isSyntheticTrigger !== true) break;
    if (startedAt !== null && message.createdAt && Date.parse(message.createdAt) < startedAt) continue;
    if (message.role === 'thinking' && message.agentMeta?.isStreaming === true) { thinking = true; continue; }
    if (!thinking && message.role === 'assistant' && message.agentMeta?.isStreaming === true
      && messageContentToPreview(message.content).trim()) return 'replying';
    if (message.role === 'tool_result') {
      if (!sawResult) resultToolId = message.toolUseId ?? (message.content && typeof message.content === 'object'
        ? (message.content as { toolUseId?: string }).toolUseId ?? null : null);
      sawResult = true;
      continue;
    }
    if (message.role === 'tool_use') {
      const tool = parseMessageToolUse(message);
      if (sawResult && resultToolId && tool.toolUseId !== resultToolId) continue;
      const action = publicToolPhase(tool.toolName, tool.input);
      const feedback = publicToolResultPhase(action);
      return sawResult && feedback !== 'processing' ? feedback : thinking ? 'thinking' : sawResult ? 'processing' : action;
    }
    if (message.role === 'assistant') break;
  }
  return thinking || normalized === 'thinking' ? 'thinking' : 'processing';
}

/** Only the current foreground turn can supply a caption. Never expose tool inputs. */
export function companionWorkingPhase(messages: readonly RemoteMessage[]): { phase: WorkingPhase | null; turnId: string } {
  let phase: WorkingPhase | null = 'thinking';
  let turnId = '';
  const tools = new Map<string, WorkingPhase>();
  for (const message of messages) {
    if (message.role === 'user') { turnId = message.id; phase = 'thinking'; tools.clear(); continue; }
    if (!turnId || message.agentMeta?.turnScope === 'background'
      || typeof message.agentMeta?.parentToolUseId === 'string' && isSubagentParentToolUseId(message.agentMeta.parentToolUseId)) continue;
    if (message.role === 'tool_use') {
      const tool = parseMessageToolUse(message);
      phase = publicToolPhase(tool.toolName, tool.input);
      if (tool.toolUseId) tools.set(tool.toolUseId, phase);
    } else if (message.role === 'tool_result') {
      const id = message.toolUseId ?? (message.content && typeof message.content === 'object' ? (message.content as Record<string, unknown>).toolUseId : null);
      if (typeof id === 'string' && tools.has(id)) { phase = publicToolResultPhase(tools.get(id)!); tools.delete(id); }
    } else if (message.role === 'assistant' && messageContentToPreview(message.content).trim()) phase = 'replying';
    else if (message.role === 'ask_user' || message.role === 'plan_review' || message.role === 'error') phase = null;
  }
  return { phase, turnId };
}
