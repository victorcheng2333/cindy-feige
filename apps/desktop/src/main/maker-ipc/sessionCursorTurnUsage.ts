import { captureTurnUsageContext, turnBillingSource, type TurnUsageContext } from './turnUsageContext.js';
import type { AgentEvent, Session } from '@cindy/maker-core';

import { buildTurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { recordSessionTurnTokens } from '../sessionSpendBroadcaster.js';
import { recordTurnUsageOnMessage } from '../turnCostBroadcaster.js';
import { cursorSubscriptionUsageModelKey } from '../usage/usageHistory.js';
import type { RegionalMoney } from '../../shared/regionalMoney.js';
import { rebroadcastTodaySpend, recordModelTurnUsage } from '../usageBroadcaster.js';

export interface RecordSessionCursorTurnUsageDeps {
  readonly turnUsageContextBySession: Map<string, TurnUsageContext>;
  readonly turnModelPromiseBySession: Map<string, Promise<string>>;
  readonly readSessionModelForUsage: (sessionId: string) => Promise<string>;
  readonly unpricedSubscriptionValueMarker: () => RegionalMoney;
}

/** Cursor SDK `TokenUsage`: `inputTokens` already includes cache reads and writes. */
export function cursorUsageToTokens(raw: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
} | null {
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Record<string, unknown>;
  const count = (key: string) => {
    const n = Number(value[key]);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  };
  const input = count('inputTokens');
  const cacheReadTokens = count('cacheReadTokens');
  const cacheCreateTokens = count('cacheWriteTokens');
  return {
    inputTokens: Math.max(0, input - cacheReadTokens - cacheCreateTokens),
    outputTokens: count('outputTokens'),
    cacheReadTokens,
    cacheCreateTokens,
  };
}

/**
 * Cursor runs bill the user's own Cursor account, never Cindy's gateway. Persist token
 * facts per model and per task; no Cindy price is applied, so the dashboard shows tokens
 * rather than an invented amount.
 */
export function recordSessionCursorTurnUsage(
  deps: RecordSessionCursorTurnUsageDeps,
  session: Session,
  event: AgentEvent,
  turnAssistantPersistId: string | undefined,
) {
  if (event.type !== 'done' || event.source !== 'cursor') return;
  const turnContext = deps.turnUsageContextBySession.get(session.id) ?? captureTurnUsageContext(session.id);
  deps.turnUsageContextBySession.delete(session.id);
  const modelPromise =
    deps.turnModelPromiseBySession.get(session.id) ?? deps.readSessionModelForUsage(session.id);
  deps.turnModelPromiseBySession.delete(session.id);
  const tokens = cursorUsageToTokens((event.data as { usage?: unknown } | undefined)?.usage);
  if (!tokens) return;
  const total = tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheCreateTokens;
  if (total <= 0) return;
  void recordSessionTurnTokens(session.id, total);
  void (async () => {
    let turnModel = 'unknown';
    try {
      turnModel = await modelPromise;
    } catch {
      // Keep the token fact even when the model cannot be read.
    }
    await recordModelTurnUsage({
      sessionId: session.id,
      agentKind: 'cursor',
      model: cursorSubscriptionUsageModelKey(turnModel),
      money: deps.unpricedSubscriptionValueMarker(),
      inputTokensDelta: tokens.inputTokens,
      outputTokensDelta: tokens.outputTokens,
      cacheReadTokensDelta: tokens.cacheReadTokens,
      cacheCreateTokensDelta: tokens.cacheCreateTokens,
    }).finally(() => rebroadcastTodaySpend());
    if (!turnAssistantPersistId) return;
    await recordTurnUsageOnMessage({
      sessionId: session.id,
      clientId: turnAssistantPersistId,
      turnUsageDetails: buildTurnUsageDetails({
        ...turnBillingSource(turnContext, 'subscription'),
        ...tokens,
        model: turnModel,
      }),
    });
  })();
}
