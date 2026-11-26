import { describe, expect, it, vi } from 'vitest';
import { BUNDLED_CATALOG } from '@cindy/model-providers';
import type { AgentEvent, Session } from '@cindy/maker-core';

const h = vi.hoisted(() => ({
  recordModelTurnUsage: vi.fn(async () => {}),
  rebroadcastTodaySpend: vi.fn(async () => {}),
  recordSessionTurnTokens: vi.fn(async () => {}),
  recordSchedulerTurnCost: vi.fn(async () => null),
  recordTurnUsageOnMessage: vi.fn(async (_args: unknown) => true),
  catalog: undefined as typeof BUNDLED_CATALOG | undefined,
  ledgerCurrency: 'USD' as 'USD' | 'CNY',
}));

vi.mock('../../usageBroadcaster.js', () => ({
  recordModelTurnUsage: h.recordModelTurnUsage,
  rebroadcastTodaySpend: h.rebroadcastTodaySpend,
}));
vi.mock('../../sessionSpendBroadcaster.js', () => ({ recordSessionTurnTokens: h.recordSessionTurnTokens }));
vi.mock('../../turnCostBroadcaster.js', () => ({
  recordSchedulerTurnCost: h.recordSchedulerTurnCost,
  recordTurnUsageOnMessage: h.recordTurnUsageOnMessage,
}));
vi.mock('../../maker-host/active-catalog.js', () => ({ getActiveCatalog: () => h.catalog }));
vi.mock('../../usage/ledgerCurrency.js', () => ({ currentLedgerCurrency: () => h.ledgerCurrency }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => true,
}));
vi.mock('../turnUsageContext.js', () => ({
  captureTurnUsageContext: () => ({ providerId: 'antigravity', providerName: 'Agy' }),
  turnBillingSource: () => ({ providerId: 'antigravity', providerName: 'Agy', billingSource: 'subscription' }),
}));

import { recordSessionNativeSubscriptionTurnUsage } from '../sessionNativeSubscriptionTurnUsage.js';

describe('recordSessionNativeSubscriptionTurnUsage', () => {
  it('ignores non-antigravity engines and runs that reported no usage', async () => {
    vi.clearAllMocks();
    const deps = {
      turnUsageContextBySession: new Map(),
      turnModelPromiseBySession: new Map(),
      readSessionModelForUsage: vi.fn(async () => 'm'),
      unpricedSubscriptionValueMarker: () => ({}) as never,
    };
    await recordSessionNativeSubscriptionTurnUsage(deps, { id: 's1' } as Session, { type: 'done', source: 'pi', data: {} } as AgentEvent, undefined);
    await recordSessionNativeSubscriptionTurnUsage(deps, { id: 's1' } as Session, { type: 'done', source: 'antigravity', data: {} } as AgentEvent, undefined);
    expect(h.recordSessionTurnTokens).not.toHaveBeenCalled();
    expect(h.recordModelTurnUsage).not.toHaveBeenCalled();
  });

  // Unit: Agy recorded all three token buckets but skipped the manufacturer
  // quote even when its exact model had a rate.
  it('records Agy API value from its separate uncached input and cache counts', async () => {
    vi.clearAllMocks();
    h.catalog = BUNDLED_CATALOG;
    const marker = { amount: 0, currency: 'USD', kind: 'value-estimate' } as never;
    const deps = {
      turnUsageContextBySession: new Map(),
      turnModelPromiseBySession: new Map([['s1', Promise.resolve('claude-opus-5-5')]]),
      readSessionModelForUsage: vi.fn(async () => 'unused'),
      unpricedSubscriptionValueMarker: () => marker,
    };
    const event = {
      source: 'antigravity', type: 'done',
      data: { usage: { inputTokens: 2_131, outputTokens: 6, cacheReadTokens: 7_591 } },
    } as AgentEvent;
    await recordSessionNativeSubscriptionTurnUsage(deps, { id: 's1' } as Session, event, 'assistant-agy');
    expect(h.recordSessionTurnTokens).toHaveBeenCalledWith('s1', 9_728);
    expect(h.recordModelTurnUsage).toHaveBeenCalledWith({
      sessionId: 's1', agentKind: 'antigravity', model: 'claude-opus-5-5#billing=subscription',
      money: expect.objectContaining({ amount: expect.closeTo(0.0101622, 9), kind: 'value-estimate' }),
      inputTokensDelta: 2_131, outputTokensDelta: 6, cacheReadTokensDelta: 7_591, cacheCreateTokensDelta: 0,
    });
    expect(h.recordSchedulerTurnCost).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'assistant-agy',
      money: expect.objectContaining({ kind: 'value-estimate' }),
      turnUsageDetails: expect.objectContaining({
        totalTokens: 9_728,
        perModelCost: [expect.objectContaining({ model: 'claude-opus-5-5' })],
      }),
    }));
  });

  it('preserves native USD reference estimates for Agy even when the account ledger currency is CNY', async () => {
    vi.clearAllMocks();
    h.catalog = BUNDLED_CATALOG;
    h.ledgerCurrency = 'CNY';
    try {
      const marker = { amount: 0, currency: 'CNY', kind: 'value-estimate' } as never;
      const deps = {
        turnUsageContextBySession: new Map(),
        turnModelPromiseBySession: new Map([['s1', Promise.resolve('gemini-4-neon')]]),
        readSessionModelForUsage: vi.fn(async () => 'unused'),
        unpricedSubscriptionValueMarker: () => marker,
      };
      const event = {
        source: 'antigravity', type: 'done',
        data: { usage: { inputTokens: 8_908, outputTokens: 1_623, cacheReadTokens: 167_384 } },
      } as AgentEvent;
      await recordSessionNativeSubscriptionTurnUsage(deps, { id: 's1' } as Session, event, 'assistant-agy-cny');
      expect(h.recordModelTurnUsage).toHaveBeenCalledWith({
        sessionId: 's1', agentKind: 'antigravity', model: 'gemini-4-neon#billing=subscription',
        money: expect.objectContaining({ amount: expect.closeTo(0.0761766, 7), currency: 'USD', kind: 'value-estimate' }),
        inputTokensDelta: 8_908, outputTokensDelta: 1_623, cacheReadTokensDelta: 167_384, cacheCreateTokensDelta: 0,
      });
      expect(h.recordSchedulerTurnCost).toHaveBeenCalledWith(expect.objectContaining({
        clientId: 'assistant-agy-cny',
        money: expect.objectContaining({ currency: 'USD', kind: 'value-estimate' }),
      }));
    } finally {
      h.ledgerCurrency = 'USD';
    }
  });
});
