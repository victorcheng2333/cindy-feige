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
vi.mock('../../usage/ledgerCurrency.js', () => ({ currentLedgerCurrency: () => 'USD' }));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({}),
  isDataOwnerBroadcastScopeCurrent: () => true,
}));
vi.mock('../turnUsageContext.js', () => ({
  captureTurnUsageContext: () => ({ providerId: 'cursor', providerName: 'Cursor' }),
  turnBillingSource: () => ({ providerId: 'cursor', providerName: 'Cursor', billingSource: 'subscription' }),
}));

import { recordSessionNativeSubscriptionTurnUsage as recordSessionCursorTurnUsage } from '../sessionCursorTurnUsage.js';

// Bug 2026-11-04: dozens of Cursor runs left sessions.total_token_usage = 0 and no
// daily_model_usage rows, because no recorder consumed Cursor's done usage. Unit, real
// recorder; the SDK reports inputTokens with cache reads/writes already included.
describe('recordSessionCursorTurnUsage', () => {
  it('records unpriced Cursor-billed tokens under the cursor engine without double-counting cache', async () => {
    vi.clearAllMocks();
    h.catalog = undefined;
    const marker = { amount: 0, currency: 'USD', kind: 'actual-cost' } as never;
    const deps = {
      turnUsageContextBySession: new Map(),
      turnModelPromiseBySession: new Map([['s1', Promise.resolve('unlisted-cursor-model')]]),
      readSessionModelForUsage: vi.fn(async () => 'unused'),
      unpricedSubscriptionValueMarker: () => marker,
    };
    const event = {
      type: 'done',
      source: 'cursor',
      data: {
        usage: { inputTokens: 80_404, outputTokens: 130, cacheReadTokens: 79_906, cacheWriteTokens: 492, totalTokens: 80_534 },
      },
    } as AgentEvent;

    await recordSessionCursorTurnUsage(deps, { id: 's1' } as Session, event, 'assistant-1');

    expect(h.recordSessionTurnTokens).toHaveBeenCalledWith('s1', 80_534);
    expect(h.recordModelTurnUsage).toHaveBeenCalledWith({
      sessionId: 's1',
      agentKind: 'cursor',
      model: 'unlisted-cursor-model#billing=subscription',
      money: marker,
      inputTokensDelta: 6,
      outputTokensDelta: 130,
      cacheReadTokensDelta: 79_906,
      cacheCreateTokensDelta: 492,
    });
    expect(h.recordTurnUsageOnMessage.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'assistant-1',
      turnUsageDetails: { billingSource: 'subscription', totalTokens: 80_534, model: 'unlisted-cursor-model' },
    });
    expect(h.recordSchedulerTurnCost).not.toHaveBeenCalled();
    expect(deps.turnModelPromiseBySession.size).toBe(0);
  });

  it('estimates Cursor API value when the model reference tariff is unambiguous', async () => {
    vi.clearAllMocks();
    h.catalog = BUNDLED_CATALOG;
    const deps = {
      turnUsageContextBySession: new Map(),
      turnModelPromiseBySession: new Map([['s1', Promise.resolve('grok-4.6')]]),
      readSessionModelForUsage: vi.fn(async () => 'unused'),
      unpricedSubscriptionValueMarker: () => ({ amount: 0, currency: 'USD', kind: 'actual-cost' }) as never,
    };
    // SDK inputTokens (23128) = uncached (21592) + cacheRead (1536)
    const event = {
      type: 'done',
      source: 'cursor',
      data: {
        usage: { inputTokens: 23_128, outputTokens: 79, cacheReadTokens: 1_536, cacheWriteTokens: 0, totalTokens: 23_207 },
      },
    } as AgentEvent;

    await recordSessionCursorTurnUsage(deps, { id: 's1' } as Session, event, 'assistant-2');

    expect(h.recordSessionTurnTokens).toHaveBeenCalledWith('s1', 23_207);
    expect(h.recordModelTurnUsage).toHaveBeenCalledWith(expect.objectContaining({
      agentKind: 'cursor',
      inputTokensDelta: 21_592,
      outputTokensDelta: 79,
      cacheReadTokensDelta: 1_536,
      cacheCreateTokensDelta: 0,
      money: expect.objectContaining({ amount: expect.closeTo(0.044426, 8), kind: 'value-estimate' }),
    }));
    expect(h.recordSchedulerTurnCost).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'assistant-2',
      money: expect.objectContaining({ amount: expect.closeTo(0.044426, 8), kind: 'value-estimate' }),
    }));
  });

  it('ignores other engines and runs that reported no usage', async () => {
    vi.clearAllMocks();
    const deps = {
      turnUsageContextBySession: new Map(),
      turnModelPromiseBySession: new Map(),
      readSessionModelForUsage: vi.fn(async () => 'm'),
      unpricedSubscriptionValueMarker: () => ({}) as never,
    };
    await recordSessionCursorTurnUsage(deps, { id: 's1' } as Session, { type: 'done', source: 'pi', data: {} } as AgentEvent, undefined);
    await recordSessionCursorTurnUsage(deps, { id: 's1' } as Session, { type: 'done', source: 'cursor', data: {} } as AgentEvent, undefined);
    expect(h.recordSessionTurnTokens).not.toHaveBeenCalled();
    expect(h.recordModelTurnUsage).not.toHaveBeenCalled();
  });

  // Unit: Agy recorded all three token buckets but skipped the manufacturer
  // quote even when its exact model had a rate. Cursor coverage didn't exercise Agy.
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
    await recordSessionCursorTurnUsage(deps, { id: 's1' } as Session, event, 'assistant-agy');
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
});
