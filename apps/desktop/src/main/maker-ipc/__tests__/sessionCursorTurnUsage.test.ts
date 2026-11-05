import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, Session } from '@cindy/maker-core';

const h = vi.hoisted(() => ({
  recordModelTurnUsage: vi.fn(async () => {}),
  rebroadcastTodaySpend: vi.fn(async () => {}),
  recordSessionTurnTokens: vi.fn(async () => {}),
  recordTurnUsageOnMessage: vi.fn(async (_args: unknown) => true),
}));
vi.mock('../../usageBroadcaster.js', () => ({
  recordModelTurnUsage: h.recordModelTurnUsage,
  rebroadcastTodaySpend: h.rebroadcastTodaySpend,
}));
vi.mock('../../sessionSpendBroadcaster.js', () => ({ recordSessionTurnTokens: h.recordSessionTurnTokens }));
vi.mock('../../turnCostBroadcaster.js', () => ({ recordTurnUsageOnMessage: h.recordTurnUsageOnMessage }));
vi.mock('../turnUsageContext.js', () => ({
  captureTurnUsageContext: () => ({ providerId: 'cursor', providerName: 'Cursor' }),
  turnBillingSource: () => ({ providerId: 'cursor', providerName: 'Cursor', billingSource: 'subscription' }),
}));

import { recordSessionCursorTurnUsage } from '../sessionCursorTurnUsage.js';

// Bug 2026-11-04: dozens of Cursor runs left sessions.total_token_usage = 0 and no
// daily_model_usage rows, because no recorder consumed Cursor's done usage. Unit, real
// recorder; the SDK reports inputTokens with cache reads/writes already included.
describe('recordSessionCursorTurnUsage', () => {
  it('records Cursor-billed tokens under the cursor engine without double-counting cache', async () => {
    const marker = { amount: 0, currency: 'USD', kind: 'actual-cost' } as never;
    const deps = {
      turnUsageContextBySession: new Map(),
      turnModelPromiseBySession: new Map([['s1', Promise.resolve('grok-4.6')]]),
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

    recordSessionCursorTurnUsage(deps, { id: 's1' } as Session, event, 'assistant-1');
    await vi.waitFor(() => expect(h.recordTurnUsageOnMessage).toHaveBeenCalledOnce());

    expect(h.recordSessionTurnTokens).toHaveBeenCalledWith('s1', 80_534);
    expect(h.recordModelTurnUsage).toHaveBeenCalledWith({
      sessionId: 's1',
      agentKind: 'cursor',
      model: 'grok-4.6#billing=subscription',
      money: marker,
      inputTokensDelta: 6,
      outputTokensDelta: 130,
      cacheReadTokensDelta: 79_906,
      cacheCreateTokensDelta: 492,
    });
    expect(h.recordTurnUsageOnMessage.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'assistant-1',
      turnUsageDetails: { billingSource: 'subscription', totalTokens: 80_534, model: 'grok-4.6' },
    });
    expect(deps.turnModelPromiseBySession.size).toBe(0);
  });

  it('ignores other engines and runs that reported no usage', () => {
    vi.clearAllMocks();
    const deps = {
      turnUsageContextBySession: new Map(),
      turnModelPromiseBySession: new Map(),
      readSessionModelForUsage: vi.fn(async () => 'm'),
      unpricedSubscriptionValueMarker: () => ({}) as never,
    };
    recordSessionCursorTurnUsage(deps, { id: 's1' } as Session, { type: 'done', source: 'pi', data: {} } as AgentEvent, undefined);
    recordSessionCursorTurnUsage(deps, { id: 's1' } as Session, { type: 'done', source: 'cursor', data: {} } as AgentEvent, undefined);
    expect(h.recordSessionTurnTokens).not.toHaveBeenCalled();
    expect(h.recordModelTurnUsage).not.toHaveBeenCalled();
  });
});
