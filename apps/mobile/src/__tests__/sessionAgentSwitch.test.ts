import { describe, expect, it } from 'vitest';

import {
  canSwitchSessionToAntigravity,
  canSwitchSessionToCursor,
  effectiveAgentDeviceId,
  intentChangesAgentLocation,
  mobileAgentLabel,
  mobileAgentLabelFromUnknown,
  mobileAgentVendor,
  normalizeSessionAgentSwitchIntent,
  readAgentSwitchLocationTarget,
  resolveAgentLocationPick,
  sessionAgentKind,
  sessionAgentRunsOnOtherComputer,
  supportsMobileSessionAgentSwitch,
} from '@/session/sessionAgentSwitch';
import type { MobileAgentCapabilities } from '@/session/agentCapabilities';
import { sessionSwitchAgentKinds } from '@/session/sessionSelectableAgents';

describe('mobile session Agent switch contract', () => {
  it('offers agy handoff only on an eligible task with a compatible host', () => {
    const task = { remoteHostId: null, agentDeviceId: null, orcaRole: null, orcaRemoteLead: null, source: 'desktop' };
    const caps = { supportsAntigravitySessionSwitch: true } as MobileAgentCapabilities;
    const available = new Set(['codex', 'antigravity']);
    expect(sessionSwitchAgentKinds(available, 'codex', false, canSwitchSessionToAntigravity(task, caps)))
      .toEqual(['codex', 'antigravity']);
    expect(canSwitchSessionToAntigravity(task, null)).toBe(false);
    // A borrowed Claude/Codex/Pi source only says where the current Agent runs; Agy runs locally.
    expect(canSwitchSessionToAntigravity({ ...task, agentDeviceId: 'borrowed' }, caps)).toBe(true);
    expect(canSwitchSessionToAntigravity({ ...task, remoteHostId: 'ssh' }, caps)).toBe(false);
    expect(sessionSwitchAgentKinds(available, 'codex')).toEqual(['codex']);
  });
  // Unit regression: old tasks used a fixed three-engine roster. Exercise the
  // production roster and the host-matching task scope, not source-code strings.
  it('offers Cursor handoff on ordinary local tasks and respects its Harness switch', () => {
    const task = { remoteHostId: null, agentDeviceId: null, orcaRole: null, orcaRemoteLead: null, source: 'desktop' };
    const available = new Set(['codex', 'cursor']);
    expect(sessionSwitchAgentKinds(available, 'codex', canSwitchSessionToCursor(task))).toEqual(['codex', 'cursor']);
    expect(sessionSwitchAgentKinds(new Set(['codex']), 'codex', true)).toEqual(['codex']);
    expect(sessionSwitchAgentKinds(new Set(['codex']), 'cursor', false)).toEqual(['codex', 'cursor']);
    // Shared Claude/Codex/Pi still hand off to local Cursor; SSH / Orca / review do not.
    expect(canSwitchSessionToCursor({ ...task, agentDeviceId: 'another-computer' })).toBe(true);
    expect(sessionSwitchAgentKinds(available, 'codex', true)).toEqual(['codex', 'cursor']);
    for (const restricted of [
      { ...task, remoteHostId: 'ssh' },
      { ...task, orcaRole: 'lead' }, { ...task, source: 'review' },
      { ...task, orcaRemoteLead: { leadDeviceId: 'lead' } },
    ]) {
      const allowed = canSwitchSessionToCursor(restricted as Parameters<typeof canSwitchSessionToCursor>[0]);
      expect(allowed).toBe(false);
      expect(sessionSwitchAgentKinds(available, 'codex', allowed)).toEqual(['codex']);
    }
  });
  it('normalizes only the public pending intent fields', () => {
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'high',
      fastMode: true,
      resumeFallbackRecovery: { handoff: 'must stay on desktop main' },
    })).toEqual({
      targetAgentKind: 'codex',
      model: 'gpt-5.5',
      providerId: null,
      effort: 'high',
      fastMode: true,
    });
    expect(normalizeSessionAgentSwitchIntent(null)).toBeNull();
    expect(normalizeSessionAgentSwitchIntent({ targetAgentKind: 'codex', model: '' })).toBeNull();
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'gemini', model: 'x', providerId: null,
    })).toBeNull();
    // providerId 缺失(undefined)按 null 处理,不丢弃合法 intent(对齐桌面 `providerId ?? null`)。
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex', model: 'gpt-5.5',
    })).toEqual({ targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null });
    // 只有非 string / 非 null / 非 undefined 的脏值才判非法。
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex', model: 'gpt-5.5', providerId: 123,
    })).toBeNull();
  });

  it('maps DB Agent kinds and labels consistently', () => {
    expect(sessionAgentKind({ agentKind: 'cc' })).toBe('claude-code');
    expect(sessionAgentKind({ agentKind: 'codex' })).toBe('codex');
    expect(sessionAgentKind({ agentKind: 'pi' })).toBe('pi');
    // Remote Cursor rows previously fell through to Claude Code (unit, one host row).
    expect(sessionAgentKind({ agentKind: 'cursor' })).toBe('cursor');
    expect(mobileAgentLabel('cursor')).toBe('Cursor');
    expect(mobileAgentLabelFromUnknown('cursor')).toBe('Cursor');
    expect(mobileAgentVendor('cursor')).toBe('cursor');
    // Host same-engine choices also arrive as pending intents; preserve the Cursor target.
    expect(normalizeSessionAgentSwitchIntent({ targetAgentKind: 'cursor', model: 'grok', providerId: 'cursor', effort: 'low' }))
      .toEqual({ targetAgentKind: 'cursor', model: 'grok', providerId: 'cursor', effort: 'low' });
    expect(mobileAgentLabel('claude-code')).toBe('Claude Code');
    expect(mobileAgentLabel('codex')).toBe('Codex');
    expect(mobileAgentLabel('pi')).toBe('Pi');
    expect(mobileAgentLabelFromUnknown('pi')).toBe('Pi');
    expect(mobileAgentVendor('claude-code')).toBe('cc');
    expect(mobileAgentVendor('codex')).toBe('codex');
    expect(mobileAgentVendor('pi')).toBe('pi');
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'pi', model: 'gpt-5.5', providerId: 'openai',
    })).toEqual({ targetAgentKind: 'pi', model: 'gpt-5.5', providerId: 'openai' });
  });

  it('requires host capability, allows Orca, and excludes SSH sessions', () => {
    const supported: MobileAgentCapabilities = {
      availableModels: [],
      effortLevels: [],
      permissionModes: [],
      hasFastMode: false,
      planModeSupported: false,
      supportsSessionAgentSwitch: true,
    };
    expect(supportsMobileSessionAgentSwitch({ remoteHostId: null, orcaRole: null }, supported)).toBe(true);
    expect(supportsMobileSessionAgentSwitch({ remoteHostId: 'ssh-1', orcaRole: null }, supported)).toBe(false);
    expect(supportsMobileSessionAgentSwitch({ remoteHostId: null, orcaRole: 'lead' }, supported)).toBe(true);
    expect(supportsMobileSessionAgentSwitch({ remoteHostId: null, orcaRole: 'worker' }, supported)).toBe(true);
    expect(supportsMobileSessionAgentSwitch(
      { remoteHostId: null, orcaRole: null },
      { ...supported, supportsSessionAgentSwitch: false },
    )).toBe(false);
    expect(supportsMobileSessionAgentSwitch({ remoteHostId: null, orcaRole: null }, null)).toBe(false);
  });
});

describe('remote Agent location (Agent runs on another computer)', () => {
  const remoteSession = { agentDeviceId: 'device-office-pc' };
  const localSession = { agentDeviceId: null };
  const intentTo = (agentDeviceId: string | null) => ({
    targetAgentKind: 'claude-code' as const, model: 'm', providerId: null, agentDeviceId,
  });

  it('keeps the optional agentDeviceId of a pending intent', () => {
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'claude-code',
      model: 'claude-sonnet-4-6',
      providerId: 'anthropic',
      agentDeviceId: null,
    })).toEqual({
      targetAgentKind: 'claude-code',
      model: 'claude-sonnet-4-6',
      providerId: 'anthropic',
      agentDeviceId: null,
    });
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null, agentDeviceId: 'device-office-pc',
    })).toEqual({
      targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null, agentDeviceId: 'device-office-pc',
    });
    // 缺省 = 位置不变,不补出该键。
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null,
    })).not.toHaveProperty('agentDeviceId');
    // 脏值与其它字段同口径判非法。
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null, agentDeviceId: 42,
    })).toBeNull();
    expect(normalizeSessionAgentSwitchIntent({
      targetAgentKind: 'codex', model: 'gpt-5.5', providerId: null, agentDeviceId: '',
    })).toBeNull();
  });

  it('tells where the Agent runs now and for the next message', () => {
    expect(sessionAgentRunsOnOtherComputer(remoteSession)).toBe(true);
    expect(sessionAgentRunsOnOtherComputer({ agentDeviceId: null })).toBe(false);
    expect(sessionAgentRunsOnOtherComputer({ agentDeviceId: '' })).toBe(false);
    expect(sessionAgentRunsOnOtherComputer({})).toBe(false);
    expect(sessionAgentRunsOnOtherComputer(null)).toBe(false);
    expect(intentChangesAgentLocation(intentTo(null))).toBe(true);
    expect(intentChangesAgentLocation(intentTo('device-studio-mac'))).toBe(true);
    expect(intentChangesAgentLocation({ targetAgentKind: 'codex', model: 'm', providerId: null })).toBe(false);
    expect(intentChangesAgentLocation(null)).toBe(false);
    expect(effectiveAgentDeviceId(remoteSession, null)).toBe('device-office-pc');
    expect(effectiveAgentDeviceId(localSession, null)).toBeNull();
    expect(effectiveAgentDeviceId(remoteSession, intentTo(null))).toBeNull();
    expect(effectiveAgentDeviceId(localSession, intentTo('device-studio-mac'))).toBe('device-studio-mac');
    // 不带位置的意图(只换引擎 / 模型)不改位置。
    expect(effectiveAgentDeviceId(remoteSession, {
      targetAgentKind: 'codex', model: 'm', providerId: null,
    })).toBe('device-office-pc');
  });

  it.each([
    { session: localSession, catalogDeviceId: null },
    { session: remoteSession, catalogDeviceId: 'device-office-pc' },
  ])('omits the position when selecting from the task’s current computer', (input) => {
    expect(resolveAgentLocationPick({ ...input, movable: false })).toEqual({});
  });

  it.each([
    { session: localSession, catalogDeviceId: 'device-studio-mac' },
    { session: remoteSession, catalogDeviceId: null },
    { session: remoteSession, catalogDeviceId: 'device-studio-mac' },
  ])('only emits a move when the task can change computers', (input) => {
    expect(resolveAgentLocationPick({ ...input, movable: true })).toEqual({ agentDeviceId: input.catalogDeviceId });
    expect(resolveAgentLocationPick({ ...input, movable: false })).toBeNull();
  });

  it('reads the boundary location only when the Agent changed computers', () => {
    expect(readAgentSwitchLocationTarget(undefined)).toBeNull();
    expect(readAgentSwitchLocationTarget({ fromAgentKind: 'cc', toAgentKind: 'codex' })).toBeNull();
    expect(readAgentSwitchLocationTarget({ toAgentDeviceId: null, toAgentDeviceName: 'Studio Mac' }))
      .toEqual({ kind: 'named', name: 'Studio Mac' });
    expect(readAgentSwitchLocationTarget({ toAgentDeviceId: null, toAgentDeviceName: null }))
      .toEqual({ kind: 'thisComputer' });
    expect(readAgentSwitchLocationTarget({ toAgentDeviceId: 'device-office-pc', toAgentDeviceName: ' ' }))
      .toEqual({ kind: 'otherComputer' });
  });
});
