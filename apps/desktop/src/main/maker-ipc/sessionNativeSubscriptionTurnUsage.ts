import { captureTurnUsageContext, turnBillingSource, type TurnUsageContext } from './turnUsageContext.js';
import type { AgentEvent, Session } from '@cindy/maker-core';
import { buildTurnUsageDetails } from '../../shared/turnUsageDetails.js';
import { estimateAntigravitySubscriptionValue } from '../usage/antigravitySubscriptionValue.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { recordSessionTurnTokens } from '../sessionSpendBroadcaster.js';
import { recordSchedulerTurnCost, recordTurnUsageOnMessage } from '../turnCostBroadcaster.js';
import { nativeSubscriptionUsageModelKey } from '../usage/usageHistory.js';
import type { RegionalMoney } from '../../shared/regionalMoney.js';
import { rebroadcastTodaySpend, recordModelTurnUsage } from '../usageBroadcaster.js';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../device-link/broadcast-tap.js';

export interface RecordSessionNativeSubscriptionTurnUsageDeps {
  readonly turnUsageContextBySession: Map<string, TurnUsageContext>;
  readonly turnModelPromiseBySession: Map<string, Promise<string>>;
  readonly readSessionModelForUsage: (sessionId: string) => Promise<string>;
  readonly unpricedSubscriptionValueMarker: () => RegionalMoney;
}

export function nativeSubscriptionUsageToTokens(raw: unknown): {
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
  return {
    inputTokens: count('inputTokens'),
    outputTokens: count('outputTokens'),
    cacheReadTokens: count('cacheReadTokens'),
    cacheCreateTokens: count('cacheWriteTokens'),
  };
}

/**
 * Manufacturer API-equivalent value belongs only to subscription estimates.
 * Persist token facts per model and per task; apply a value-estimate only when
 * the model's standard API tariff is unambiguous across buckets.
 */
export async function recordSessionNativeSubscriptionTurnUsage(
  deps: RecordSessionNativeSubscriptionTurnUsageDeps,
  session: Session,
  event: AgentEvent,
  clientId: string | undefined,
): Promise<void> {
  const source = event.source;
  if (source !== 'antigravity' || (event.type !== 'done' && event.type !== 'error')) return;
  if (event.type === 'error' &&
      (event.data as { isTerminal?: boolean } | undefined)?.isTerminal !== true) return;
  const owner = captureDataOwnerBroadcastScope();
  const turnContext = deps.turnUsageContextBySession.get(session.id) ?? captureTurnUsageContext(session.id);
  deps.turnUsageContextBySession.delete(session.id);
  const modelPromise =
    deps.turnModelPromiseBySession.get(session.id) ?? deps.readSessionModelForUsage(session.id);
  deps.turnModelPromiseBySession.delete(session.id);
  const tokens = nativeSubscriptionUsageToTokens((event.data as { usage?: unknown } | undefined)?.usage);
  if (!tokens) return;
  const totalTokens = tokens.inputTokens + tokens.outputTokens + tokens.cacheReadTokens + tokens.cacheCreateTokens;
  if (totalTokens <= 0) return;

  const registry = getActiveCatalog()?.modelRegistry;
  const at = new Date().toISOString();
  let model = session.model ?? 'unknown';
  await recordSessionTurnTokens(session.id, totalTokens);
  try {
    model = await modelPromise;
  } catch {
    // Keep the token fact even when the model cannot be read.
  }
  if (!isDataOwnerBroadcastScopeCurrent(owner)) return;

  const money = estimateAntigravitySubscriptionValue(registry, model, tokens, at);
  const details = buildTurnUsageDetails({
    ...turnBillingSource(turnContext, 'subscription'),
    ...(turnContext.providerId !== source
      ? { providerId: source, providerName: 'Agy' } : {}),
    ...tokens,
    model,
    ...(money ? { perModelCost: [{ model, money }] } : {}),
  });
  await recordModelTurnUsage({
    sessionId: session.id,
    agentKind: source,
    // Preserve separate counters for Agy turns whose tariff was unavailable.
    // History can estimate those tokens when a dated quote becomes available.
    model: money?.amount ? nativeSubscriptionUsageModelKey(model) : model,
    money: money ?? deps.unpricedSubscriptionValueMarker(),
    inputTokensDelta: tokens.inputTokens,
    outputTokensDelta: tokens.outputTokens,
    cacheReadTokensDelta: tokens.cacheReadTokens,
    cacheCreateTokensDelta: tokens.cacheCreateTokens,
  });
  if (!isDataOwnerBroadcastScopeCurrent(owner)) return;
  if (money?.amount) {
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
