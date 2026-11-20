import { captureTurnUsageContext, turnBillingSource, type TurnUsageContext } from './turnUsageContext.js';
import type { AgentEvent, Session } from '@cindy/maker-core';
import { buildTurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { cursorApiValue } from '../usage/cursorApiValue.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { currentLedgerCurrency } from '../usage/ledgerCurrency.js';
import { recordSessionTurnTokens } from '../sessionSpendBroadcaster.js';
import { recordSchedulerTurnCost, recordTurnUsageOnMessage } from '../turnCostBroadcaster.js';
import { cursorSubscriptionUsageModelKey } from '../usage/usageHistory.js';
import type { RegionalMoney } from '../../shared/regionalMoney.js';
import { rebroadcastTodaySpend, recordModelTurnUsage } from '../usageBroadcaster.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../device-link/broadcast-tap.js';

export interface RecordSessionCursorTurnUsageDeps {
  readonly turnUsageContextBySession: Map<string, TurnUsageContext>;
  readonly turnModelPromiseBySession: Map<string, Promise<string>>;
  readonly readSessionModelForUsage: (sessionId: string) => Promise<string>;
  readonly unpricedSubscriptionValueMarker: () => RegionalMoney;
}

/** Cursor SDK `TokenUsage`: `inputTokens` already includes cache reads and writes. */
export function cursorUsageToTokens(raw: unknown, inputIncludesCache = true): {
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
    inputTokens: inputIncludesCache ? Math.max(0, input - cacheReadTokens - cacheCreateTokens) : input,
    outputTokens: count('outputTokens'),
    cacheReadTokens,
    cacheCreateTokens,
  };
}

/**
 * Manufacturer API-equivalent value is never Cindy spend or a Cursor invoice.
 * Persist token facts per model and per task; apply a value-estimate only when
 * the model's standard API tariff is unambiguous across buckets.
 */
export async function recordSessionNativeSubscriptionTurnUsage(
  deps: RecordSessionCursorTurnUsageDeps,
  session: Session,
  event: AgentEvent,
  clientId: string | undefined,
): Promise<void> {
  const source = event.source;
  if ((source !== 'cursor' && source !== 'antigravity') || (event.type !== 'done' && event.type !== 'error')) return;
  if (source === 'antigravity' && event.type === 'error' &&
      (event.data as { isTerminal?: boolean } | undefined)?.isTerminal !== true) return;
  const owner = captureDataOwnerBroadcastScope();
  const turnContext = deps.turnUsageContextBySession.get(session.id) ?? captureTurnUsageContext(session.id);
  deps.turnUsageContextBySession.delete(session.id);
  const modelPromise =
    deps.turnModelPromiseBySession.get(session.id) ?? deps.readSessionModelForUsage(session.id);
  deps.turnModelPromiseBySession.delete(session.id);
  const tokens = cursorUsageToTokens((event.data as { usage?: unknown } | undefined)?.usage, source === 'cursor');
  if (!tokens) return;
  const totalTokens = tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheCreateTokens;
  if (totalTokens <= 0) return;

  const pricing = source === 'cursor'
    ? { registry: getActiveCatalog()?.modelRegistry, currency: currentLedgerCurrency(), at: new Date().toISOString() }
    : null;
  let model = session.model ?? 'unknown';
  await recordSessionTurnTokens(session.id, totalTokens);
  try {
    model = await modelPromise;
  } catch {
    // Keep the token fact even when the model cannot be read.
  }
  if (!isDataOwnerBroadcastScopeCurrent(owner)) return;

  const money = pricing ? cursorApiValue(pricing.registry, model, tokens, pricing.currency, pricing.at) : undefined;
  const details = buildTurnUsageDetails({
    ...turnBillingSource(turnContext, 'subscription'),
    ...tokens,
    model,
    ...(money ? { perModelCost: [{ model, money }] } : {}),
  });
  await recordModelTurnUsage({
    sessionId: session.id,
    agentKind: source,
    model: source === 'cursor' ? cursorSubscriptionUsageModelKey(model) : model,
    money: money ?? deps.unpricedSubscriptionValueMarker(),
    inputTokensDelta: tokens.inputTokens,
    outputTokensDelta: tokens.outputTokens,
    cacheReadTokensDelta: tokens.cacheReadTokens,
    cacheCreateTokensDelta: tokens.cacheCreateTokens,
  });
  if (!isDataOwnerBroadcastScopeCurrent(owner)) return;
  if (money) {
    await recordSchedulerTurnCost({
      sessionId: session.id,
      clientId,
      money,
      turnUsageDetails: details,
      turnOrigin: event.turnOrigin,
    });
  } else if (clientId && details) {
    await recordTurnUsageOnMessage({ sessionId: session.id, clientId, turnUsageDetails: details });
  }
  void rebroadcastTodaySpend();
}
