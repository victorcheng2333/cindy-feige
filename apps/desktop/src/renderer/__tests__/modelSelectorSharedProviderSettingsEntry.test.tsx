// @vitest-environment jsdom
/**
 * 模型面板底部「配置模型」：本机目录与分享来的供应商显示，点分享来的供应商时带上分享 id，
 * 设置页直接选中那一条(provider-sharing.md §5.2)。自己其他电脑与被控电脑上的目录要到那台电脑上改，不显示。
 */
import type { ModelSelectorContentBaseProps } from '../components/new-chat/ModelSelector';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The shared-quota rail observes auth; this component fixture has no auth host.
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuthUser: () => null, useOptionalAuthDeviceId: () => null }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, options?: Record<string, string>) =>
      key === 'newChat.modelSelector.unified.railRemoteProvider'
        ? `${options?.provider ?? ''} · ${options?.device ?? ''}`
        : options?.defaultValue ?? key,
  }),
}));

vi.mock('@/lib/scrollbarAutoHide', () => ({ flashScrollbar: vi.fn() }));

const capabilityRequests = vi.hoisted(() => ({
  calls: [] as Array<{ agent: string | null | undefined; deviceId: string | undefined }>,
  errorByKey: {} as Record<string, string>,
}));

vi.mock('@/hooks/useAgentCapabilities', () => ({
  evictDeviceCapabilities: vi.fn(),
  prefetchDeviceCapabilities: vi.fn(async () => {}),
  useAgentCapabilities: (agent: string | null | undefined, deviceId?: string) => {
    capabilityRequests.calls.push({ agent, deviceId });
    const error = agent && deviceId ? capabilityRequests.errorByKey[`${deviceId}:${agent}`] ?? null : null;
    return {
      capabilities: error ? null : { hasFastMode: false, effortLevels: [], availableModels:
        agent === 'cursor' && deviceId === 'device-b'
          ? [{ id: 'm5-cursor', displayName: 'M5 Cursor model', contextWindow: 200000, efforts: [], defaultEffort: null }] : [] },
      loading: false,
      error,
    };
  },
}));
vi.mock('@/hooks/useApiKey', () => ({ useApiKey: () => ({ hasSavedKey: true }) }));
vi.mock('@/hooks/useConnectedSource', () => ({
  useConnectedSource: () => ({ hasConnectedSource: true, loading: false }),
}));
vi.mock('@/hooks/useModelPricing', () => ({
  useGatewayModelPricing: () => null,
  useReferenceModelPricing: () => null,
}));

const catalogs = vi.hoisted(() => {
  const provider = (id: string, name: string, modelId: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    source: 'user',
    agents: ['claude-code'],
    auth: { method: 'api-key' },
    routing: { 'claude-code': {} },
    connected: true,
    models: {
      'claude-code': [
        { id: modelId, name: modelId, contextWindow: 200000, efforts: ['high'], defaultEffort: 'high' },
      ],
    },
    ...extra,
  });
  return {
    shareError: null as string | null,
    shareLoading: false,
    deviceError: {} as Record<string, string | null>,
    deviceLoading: {} as Record<string, boolean>,
    local: [provider('a-local', 'A Local', 'a-model')] as unknown[],
    byDevice: {
      'device-b': [provider('b-main', 'B Main', 'b-model'),
        provider('cursor', 'Cursor', 'm5-cursor', { agents: ['cursor'], routing: { cursor: {} },
          models: { cursor: [{ id: 'm5-cursor', name: 'M5 Cursor model', contextWindow: 200000, efforts: [], defaultEffort: null }] } })],
      'device-c': [provider('c-open', 'C Open', 'c-model', { remoteInvocationEnabled: true })],
      'share:abc': [provider('s-shared', 'S Shared', 's-model', { remoteInvocationEnabled: true })],
    } as Record<string, unknown[]>,
  };
});

const shareState = vi.hoisted(() => ({ received: [] as Array<Record<string, unknown>> }));
vi.mock('@/features/provider-share/providerShareStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/provider-share/providerShareStore')>()),
  useProviderShareReceived: () => ({ received: shareState.received, loaded: true }),
}));

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: catalogs.local, providerOrder: [] }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  evictDeviceProviders: vi.fn(),
  prefetchDeviceProviders: vi.fn(async () => {}),
  useDeviceProviders: (deviceId?: string) => {
    const error = deviceId === 'share:abc' ? catalogs.shareError : deviceId ? (catalogs.deviceError[deviceId] ?? null) : null;
    const loading = deviceId === 'share:abc' ? catalogs.shareLoading : deviceId ? Boolean(catalogs.deviceLoading[deviceId]) : false;
    return {
      providers: error || loading ? [] : deviceId ? (catalogs.byDevice[deviceId] ?? []) : [],
      loading,
      error,
      unsupported: false,
    };
  },
}));
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: (deviceIds: readonly string[]) =>
    new Map(
      deviceIds.map((deviceId) => {
        const error = deviceId === 'share:abc' ? catalogs.shareError : (catalogs.deviceError[deviceId] ?? null);
        const loading = deviceId === 'share:abc' ? catalogs.shareLoading : Boolean(catalogs.deviceLoading[deviceId]);
        return [
          deviceId,
          { providers: error || loading ? [] : catalogs.byDevice[deviceId] ?? [], loading, error },
        ];
      }),
    ),
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  isModelEnabled: () => true,
  useModelVisibilityVersion: () => 0,
}));
vi.mock('@/state/deviceLinkModelMirror', () => ({
  useDeviceLinkModelMirrorVersion: () => 0,
}));
vi.mock('@/hooks/useRemoteDeviceUsage', () => ({
  useRemoteCodexAccountUsage: () => null,
  useRemoteXaiSubscriptionUsage: () => null,
}));
vi.mock('@/hooks/useRemoteClaudeSubscriptionUsage', () => ({
  useRemoteClaudeSubscriptionUsage: () => null,
}));

import { ModelSelectorContent } from '@/components/new-chat/ModelSelector';
import { prefetchDeviceProviders } from '@/hooks/useDeviceProviders';
import { __resetForTest as resetEnginePrefs } from '@/state/modelEnginePrefs';
import { __resetForTest as resetFavorites } from '@/state/modelFavorites';

const studio = { deviceId: 'device-c', name: 'Studio' };
const share = { deviceId: 'share:abc', name: '来自 Magi 的分享' };
const SHARE_CELL = 'S Shared · 来自 Magi 的分享';
const ENTRY = 'newChat.modelSelector.source.connect';

type Props = React.ComponentProps<typeof ModelSelectorContent>;

function renderPanel(
  remoteAgent: Partial<NonNullable<Props['remoteAgent']>> = {},
  props: Partial<ModelSelectorContentBaseProps> = {},
) {
  const onNavigateToProviders = vi.fn();
  const onUnifiedSelect = vi.fn(async () => true);
  const panel = () => React.createElement(ModelSelectorContent, {
      // This suite also exercises the retained unified panel's source rail.
      unifiedPanel: true,
      modelId: 'a-model',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: 'a-local',
      onProviderChange: vi.fn(),
      onUnifiedSelect,
      vendorKey: 'cc',
      onNavigateToProviders,
      remoteAgent: { devices: [studio, share], selectedDeviceId: null, ...remoteAgent },
      ...props,
    });
  const result = render(panel());
  return { onNavigateToProviders, onUnifiedSelect, refresh: () => result.rerender(panel()) };
}

async function browse(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  catalogs.shareError = null;
  catalogs.shareLoading = false;
  catalogs.deviceError = {};
  catalogs.deviceLoading = {};
  capabilityRequests.calls = [];
  capabilityRequests.errorByKey = {};
  catalogs.byDevice['share:abc'] = [{ ...(catalogs.byDevice['share:abc'][0] as object), connected: true, hidden: false }];
  shareState.received = [];
  vi.clearAllMocks();
  resetEnginePrefs();
  resetFavorites();
});

afterEach(() => {
  cleanup();
});

describe('模型面板底部「配置模型」', () => {
  // Unit / #10826: a known share with no cached catalog must expose retry and
  // recover selection. Existing fixtures only exercised already-loaded shares.
  it('keeps a first-load failed share browsable and selects its model after retry', async () => {
    catalogs.shareError = 'share catalog unavailable';
    const panel = renderPanel();
    await browse(share.name);
    expect(screen.getByRole('alert').textContent).toContain('newChat.modelSelector.remoteLoadFailed');
    await browse('newChat.modelSelector.retryRemoteModels');
    expect(prefetchDeviceProviders).toHaveBeenCalledWith('share:abc');
    catalogs.shareError = null;
    catalogs.shareLoading = true;
    panel.refresh();
    expect(screen.getByRole('button', { name: share.name })).toBeTruthy();
    catalogs.shareLoading = false;
    panel.refresh();
    expect(screen.queryByRole('alert')).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole('option', { name: 's-model high' })); });
    expect(panel.onUnifiedSelect).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 's-shared', modelId: 's-model', agentDevice: share,
    }));
  });
  // Gap (2026-11-23 real run): once the sharer's computer went offline its provider read as
  // disconnected, the share had no listed models and vanished from the rail, coming back with the
  // owner's presence. Minimal input: an active share whose owner is offline and provider disconnected.
  it('keeps a share whose owner computer is offline in the rail and explains it instead of an empty list', async () => {
    catalogs.byDevice['share:abc'] = [{ ...(catalogs.byDevice['share:abc'][0] as object), connected: false }];
    shareState.received = [{ shareId: 'abc', memberId: 'm', providerId: 's-shared', providerLabel: 'S Shared',
      hostDeviceId: 'host', deviceName: 'Cindy', owner: { displayName: 'Magi', avatarUrl: null, region: 'global' },
      status: 'active', hostOnline: false, hostCapable: false }];
    renderPanel();
    await browse(SHARE_CELL);
    expect(screen.getAllByRole('status').some((node) => node.textContent?.includes('providerShare.received.offlineNote'))).toBe(true);
    expect(screen.queryByText('newChat.modelSelector.search.noResults')).toBeNull();
  });

  // Review (#12246): keeping an offline share must not bring back a share its owner hid from the
  // picker. Minimal input: the same offline share, with its provider marked hidden.
  it('does not bring a hidden share back into the rail while its owner computer is offline', () => {
    catalogs.byDevice['share:abc'] = [{ ...(catalogs.byDevice['share:abc'][0] as object), connected: false, hidden: true }];
    shareState.received = [{ shareId: 'abc', memberId: 'm', providerId: 's-shared', providerLabel: 'S Shared',
      hostDeviceId: 'host', deviceName: 'Cindy', owner: { displayName: 'Magi', avatarUrl: null, region: 'global' },
      status: 'active', hostOnline: false, hostCapable: false }];
    renderPanel();
    expect(screen.queryByRole('button', { name: SHARE_CELL })).toBeNull();
  });

  it('本机目录照旧显示，打开供应商页不带目标', () => {
    const { onNavigateToProviders } = renderPanel();
    fireEvent.click(screen.getByRole('button', { name: ENTRY }));
    expect(onNavigateToProviders).toHaveBeenCalledOnce();
    expect(onNavigateToProviders).toHaveBeenCalledWith(undefined);
  });

  it('浏览分享来的供应商时显示，点击带上这条分享', async () => {
    const { onNavigateToProviders } = renderPanel();
    await browse(SHARE_CELL);
    fireEvent.click(screen.getByRole('button', { name: ENTRY }));
    expect(onNavigateToProviders).toHaveBeenCalledWith({ shareId: 'abc' });
  });

  it('Agent 已在分享上：打开时停在分享的目录，同样带上这条分享', () => {
    const { onNavigateToProviders } = renderPanel(
      { selectedDeviceId: 'share:abc' },
      { modelId: 's-model', currentProviderId: 's-shared' },
    );
    fireEvent.click(screen.getByRole('button', { name: ENTRY }));
    expect(onNavigateToProviders).toHaveBeenCalledWith({ shareId: 'abc' });
  });

  it('自己其他电脑上的远程供应商不显示(要到那台电脑上改)', async () => {
    renderPanel();
    await browse('C Open · Studio');
    expect(screen.queryByRole('button', { name: ENTRY })).toBeNull();
  });

  it('被控电脑上的任务：浏览分享来的供应商也不显示(本机设置管不到那台电脑)', async () => {
    renderPanel(
      { homeDeviceId: 'device-b' },
      { deviceId: 'device-b', modelId: 'b-model', currentProviderId: 'b-main' },
    );
    expect(screen.queryByRole('button', { name: ENTRY })).toBeNull();
    await browse(SHARE_CELL);
    expect(screen.queryByRole('button', { name: ENTRY })).toBeNull();
  });
});

// Regression: legacy picker omitted the remote source entry and execution device.
// Tier: standard. Existing tests covered only the unified rail; click the real
// legacy source selector and model row to verify the submitted route.
describe('旧版选择器分享来源', () => {
  async function selectShare() {
    await act(async () => {
      fireEvent.keyDown(screen.getByRole('combobox', { name: 'newChat.modelSelector.source.railLabel' }), { key: 'ArrowDown' });
    });
    await act(async () => {
      fireEvent.click(screen.getByRole('option', { name: SHARE_CELL }));
    });
  }

  it('本机草稿可浏览分享并提交远程模型和执行电脑', async () => {
    const onUnifiedSelect = vi.fn(async () => true);
    renderPanel({}, { unifiedPanel: false, onUnifiedSelect });
    await selectShare();
    await act(async () => { fireEvent.click(screen.getByText('s-model')); });
    expect(onUnifiedSelect).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 's-shared', modelId: 's-model', engine: 'cc',
      agentDevice: { deviceId: share.deviceId, name: share.name },
    }));
  });

  it('已有任务选分享模型时迁移执行位置，不调用本机换供应商', async () => {
    const onRelocate = vi.fn(async () => true);
    const onProviderChange = vi.fn();
    renderPanel({ onRelocate }, { unifiedPanel: false, onUnifiedSelect: undefined, onProviderChange });
    await selectShare();
    await act(async () => { fireEvent.click(screen.getByText('s-model')); });
    expect(onRelocate).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 's-shared', modelId: 's-model', agent: 'claude-code',
      agentDevice: { deviceId: share.deviceId, name: share.name },
      retryQueuedSend: true,
    }));
    expect(onProviderChange).not.toHaveBeenCalled();
  });
});

// Unit: the combined composer must distinguish identical provider/model IDs on
// different computers. Existing source-switch tests never render them together.
// Select the other copy and assert its execution device and own effort defaults.
describe('合并供应商列表', () => {
  it('当前 Harness 在所有来源都没有模型时显示空态', () => {
    renderPanel({ devices: [share] }, {
      unifiedPanel: false, compactProviderList: true, vendorKey: 'codex',
    });
    expect(screen.queryByRole('option')).toBeNull();
    expect(screen.getByText('newChat.modelSelector.search.noResults')).toBeTruthy();
  });

  it.each([null, 'share:abc'])('同名路由只选中实际电脑，切换保留来源和档位（%s）', async selectedDeviceId => {
    const original = catalogs.byDevice['share:abc'];
    const local = catalogs.local[0] as Record<string, unknown>;
    const remote = {
      ...local,
      remoteInvocationEnabled: true,
      models: { 'claude-code': [{ id: 'a-model', name: 'a-model', contextWindow: 200000, efforts: ['low', 'high'], defaultEffort: 'low' }] },
    };
    catalogs.byDevice['share:abc'] = [
      remote,
      { ...remote, id: 'private', name: 'Private', remoteInvocationEnabled: false },
      { ...remote, id: 'codex-only', name: 'Codex Only', agents: ['codex'], routing: { codex: {} }, models: { codex: [{ id: 'codex-model', name: 'codex-model', contextWindow: 200000, efforts: [] }] } },
    ];
    try {
      const onUnifiedSelect = vi.fn(async () => true);
      renderPanel({ devices: [share], selectedDeviceId }, {
        unifiedPanel: false, compactProviderList: true, onUnifiedSelect,
        effort: selectedDeviceId ? 'low' : 'high',
      });
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('tablist')).toBeNull();
      expect(screen.getAllByRole('listbox')).toHaveLength(1);
      const groups = screen.getAllByRole('group', { name: 'A Local' });
      expect(groups).toHaveLength(2);
      expect(within(groups[1]).getByText(share.name)).toBeTruthy();
      expect(within(groups[0]).queryByText(share.name)).toBeNull();
      expect(screen.queryByText('Private')).toBeNull();
      expect(screen.queryByText('Codex Only')).toBeNull();
      const rows = groups.map(group => within(group).getByRole('option'));
      expect(rows.map(row => row.getAttribute('aria-selected'))).toEqual(selectedDeviceId ? ['false', 'true'] : ['true', 'false']);
      await act(async () => { fireEvent.click(rows[selectedDeviceId ? 0 : 1]); });
      expect(onUnifiedSelect).toHaveBeenCalledWith(expect.objectContaining({
        providerId: 'a-local', modelId: 'a-model', engine: 'cc',
        agentDevice: selectedDeviceId ? null : share,
        effort: selectedDeviceId ? 'high' : 'low',
      }));
    } finally {
      catalogs.byDevice['share:abc'] = original;
    }
  });
});

// Regression 121c3603752: compact task picker hid the harness tabs. Existing
// combined-list tests only select same-harness draft rows. Unit: render the real
// task picker, switch its tab, and verify local handoff / remote relocation.
// Standalone Vitest run: 3.64s (12 tests, 397ms execution).
describe('精简任务列表跨 harness 切换', () => {
  it.each(['codex', 'pi'] as const)('浏览 %s 保留合并来源，选模型后才登记切换', async agent => {
    const originalLocal = catalogs.local;
    const originalRemote = catalogs.byDevice['share:abc'];
    const provider = (id: string) => ({
      ...(originalLocal[0] as object), id, name: id, agents: [agent],
      routing: { [agent]: {} }, remoteInvocationEnabled: true,
      models: { [agent]: [{ id: `${agent}-model`, name: `${agent}-model`, contextWindow: 200000, efforts: ['high'], defaultEffort: 'high' }] },
    });
    catalogs.local = [...originalLocal, provider('target-local')];
    catalogs.byDevice['share:abc'] = [...originalRemote, provider('target-remote')];
    try {
      const onSwitch = vi.fn(async () => true);
      const onRelocate = vi.fn(async () => true);
      const onProviderChange = vi.fn();
      renderPanel({ devices: [share], onRelocate }, {
        unifiedPanel: false, compactProviderList: true, onUnifiedSelect: undefined,
        onProviderChange, agentSwitch: { currentVendor: 'cc', onSwitch },
      });
      const tab = screen.getByRole('tab', { name: agent === 'codex' ? 'Codex' : 'Pi' });
      await act(async () => { fireEvent.click(tab); });
      expect(tab.getAttribute('aria-selected')).toBe('true');
      expect(onSwitch).not.toHaveBeenCalled();
      expect(onRelocate).not.toHaveBeenCalled();
      expect(screen.getAllByRole('tablist')).toHaveLength(1);
      expect(screen.getAllByRole('listbox')).toHaveLength(1);
      expect(screen.queryByRole('textbox')).toBeNull();
      expect(screen.queryByRole('combobox')).toBeNull();
      expect(screen.getByRole('tab', { name: 'Cursor' })).toBeTruthy();
      const local = screen.getByRole('group', { name: 'target-local' });
      const remote = screen.getByRole('group', { name: 'target-remote' });
      await act(async () => { fireEvent.click(within(local).getByRole('option')); });
      expect(onSwitch).toHaveBeenCalledWith(agent, `${agent}-model`, 'target-local', expect.any(Object));
      await act(async () => { fireEvent.click(within(remote).getByRole('option')); });
      expect(onRelocate).toHaveBeenCalledWith(expect.objectContaining({
        agent, modelId: `${agent}-model`, providerId: 'target-remote', agentDevice: share,
      }));
      expect(onProviderChange).not.toHaveBeenCalled();
    } finally {
      catalogs.local = originalLocal;
      catalogs.byDevice['share:abc'] = originalRemote;
    }
  });
});

// Unit: 2026-11-15 new-task parity. Existing cases cover session handoff only.
// Minimal input: compact draft with a Codex model and Cursor disabled; browsing
// restores the parent-owned draft selection, and model selection emits the full tuple.
// Focused run: 5.16s wall clock, 135ms test execution.
describe('新任务引擎标签', () => {
  it('切引擎恢复草稿选择，继续选模型提交完整配置，并隐藏关闭的 Cursor', async () => {
    const originalLocal = catalogs.local;
    catalogs.local = [...originalLocal, {
      ...(originalLocal[0] as object), id: 'codex-source', name: 'Codex Source',
      agents: ['codex'], routing: { codex: {} },
      models: { codex: [{ id: 'codex-model', name: 'Codex Model', contextWindow: 200000,
        efforts: ['low', 'high'], defaultEffort: 'low' }] },
    }];
    try {
      const onUnifiedSelect = vi.fn(async () => true);
      function DraftPicker() {
        const [vendor, setVendor] = React.useState<'cc' | 'codex' | 'pi' | 'cursor' | 'antigravity'>('cc');
        return <ModelSelectorContent
          modelId={vendor === 'codex' ? 'codex-model' : 'a-model'}
          currentProviderId={vendor === 'codex' ? 'codex-source' : 'a-local'}
          effort="high" vendorKey={vendor} onModelChange={vi.fn()} onEffortChange={vi.fn()}
          remoteAgent={{ devices: [], selectedDeviceId: null }}
          compactProviderList draftEngineTabs onDraftVendorChange={setVendor}
          unifiedAgents={['claude-code', 'codex']} onUnifiedSelect={onUnifiedSelect}
        />;
      }
      render(<DraftPicker />);
      expect(screen.queryByRole('tab', { name: 'Cursor' })).toBeNull();
      await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Codex' })); });
      expect(onUnifiedSelect).not.toHaveBeenCalled();
      expect(screen.queryByText('newChat.modelSelector.agentSwitch.hint')).toBeNull();
      expect(within(screen.getByRole('group', { name: 'Codex Source' })).getByRole('option').getAttribute('aria-selected')).toBe('true');
      await act(async () => {
        fireEvent.click(within(screen.getByRole('group', { name: 'Codex Source' })).getByRole('option'));
      });
      expect(onUnifiedSelect).toHaveBeenCalledWith(expect.objectContaining({
        providerId: 'codex-source', modelId: 'codex-model', engine: 'codex', effort: 'high', fast: false,
      }));
    } finally { catalogs.local = originalLocal; }
  });
});

// Unit regression (2026-11-15): remote Claude catalogs hid the Cursor tab.
// Existing cases only switch Codex/Pi on local catalogs. Minimum input: a remote
// catalog with Cursor in the selectable roster; the real picker must expose the
// tab and switch its browsing state. Tier: unit (in-memory provider fixtures).
describe('远程目录 Cursor 入口', () => {
  it('浏览远程 Claude 来源时仍可切换到 Cursor', async () => {
    const onSwitch = vi.fn(async () => true);
    renderPanel({ devices: [], selectedDeviceId: null, homeDeviceId: 'device-b' }, {
      unifiedPanel: false, compactProviderList: true, onUnifiedSelect: undefined,
      unifiedAgents: ['claude-code', 'cursor'],
      agentSwitch: { currentVendor: 'cc', onSwitch },
    });
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Cursor' })); });
    expect(screen.getByRole('tab', { name: 'Cursor' }).getAttribute('aria-selected')).toBe('true');
    expect(onSwitch).not.toHaveBeenCalled();
    // The active task is still Claude: browsing Cursor must load the controlled
    // computer's capabilities before an engine switch, rather than local/empty caps.
    await act(async () => { fireEvent.click(screen.getAllByText('M5 Cursor model')[0]!); });
    expect(onSwitch).toHaveBeenCalledWith('cursor', 'm5-cursor', 'cursor', expect.any(Object));
  });
});

// Unit regression (2026-11-23): opening or switching to Agy in the compact picker
// mounted other computers whose catalog was loading/errored or selected for another
// Harness, firing antigravity capability reads and flashing remote load errors for
// computers that never shared Agy. Minimal input: a local Agy model plus an own
// computer (Studio) that does not share Agy (loading, errored, or selected on Claude)
// and a failed share. Tier: unit (in-memory provider fixtures).
describe('Agy 列表不误查未共享 Agy 的远程电脑', () => {
  const localAgyProvider = {
    id: 'antigravity', name: 'Agy', source: 'builtin', agents: ['antigravity'],
    auth: { method: 'oauth' }, routing: { antigravity: {} }, connected: true,
    models: { antigravity: [{ id: 'agy-local', name: 'Agy Local Model', contextWindow: 200000, efforts: [], defaultEffort: null }] },
  };

  it('其他电脑目录加载中或失败、以及分享失败时，打开 Agy 不显示它们的错误也不查其 Agy 能力', () => {
    const originalLocal = catalogs.local;
    catalogs.local = [...originalLocal, localAgyProvider];
    catalogs.deviceLoading['device-c'] = true;
    catalogs.shareError = 'share catalog unavailable';
    capabilityRequests.errorByKey['device-c:antigravity'] = 'antigravity not available';
    capabilityRequests.errorByKey['share:abc:antigravity'] = 'UNSUPPORTED_CAPABILITY';
    try {
      const panel = renderPanel({ devices: [studio, share], selectedDeviceId: null }, {
        unifiedPanel: false, compactProviderList: true, vendorKey: 'antigravity',
        modelId: 'agy-local', currentProviderId: 'antigravity',
      });
      expect(screen.getByRole('option', { name: 'Agy Local Model' })).toBeTruthy();
      expect(screen.queryByText(studio.name)).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByText('newChat.modelSelector.remoteLoading')).toBeNull();
      expect(capabilityRequests.calls.some((call) => call.agent === 'antigravity' && call.deviceId === 'device-c')).toBe(false);
      expect(capabilityRequests.calls.some((call) => call.agent === 'antigravity' && call.deviceId === 'share:abc')).toBe(false);

      catalogs.deviceLoading['device-c'] = false;
      catalogs.deviceError['device-c'] = 'offline';
      panel.refresh();
      expect(screen.queryByText(studio.name)).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(capabilityRequests.calls.some((call) => call.agent === 'antigravity' && call.deviceId === 'device-c')).toBe(false);
    } finally {
      catalogs.local = originalLocal;
    }
  });

  it('当前任务运行在其他电脑的 Claude 上时，切到 Agy 标签页不显示那台电脑的失败提示', async () => {
    const originalLocal = catalogs.local;
    catalogs.local = [...originalLocal, localAgyProvider];
    capabilityRequests.errorByKey['device-c:antigravity'] = 'antigravity not available';
    try {
      renderPanel({ devices: [studio], selectedDeviceId: 'device-c' }, {
        unifiedPanel: false, compactProviderList: true, onUnifiedSelect: undefined,
        vendorKey: 'cc', modelId: 'c-model', currentProviderId: 'c-open',
        unifiedAgents: ['claude-code', 'antigravity'],
        agentSwitch: { currentVendor: 'cc', onSwitch: vi.fn(async () => true) },
      });
      await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Agy' })); });
      expect(screen.getByRole('option', { name: 'Agy Local Model' })).toBeTruthy();
      expect(screen.queryByText(studio.name)).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(capabilityRequests.calls.some((call) => call.agent === 'antigravity' && call.deviceId === 'device-c')).toBe(false);
    } finally {
      catalogs.local = originalLocal;
    }
  });

  it('其他电脑明确远程共享了 Agy 时，Agy 列表仍正常列出它的模型', () => {
    const originalLocal = catalogs.local;
    const originalStudio = catalogs.byDevice['device-c'];
    catalogs.local = [...originalLocal, localAgyProvider];
    catalogs.byDevice['device-c'] = [
      ...originalStudio,
      {
        ...localAgyProvider,
        remoteInvocationEnabled: true,
        models: { antigravity: [{ id: 'agy-studio', name: 'Agy Studio Model', contextWindow: 200000, efforts: [], defaultEffort: null }] },
      },
    ];
    try {
      renderPanel({ devices: [studio], selectedDeviceId: null }, {
        unifiedPanel: false, compactProviderList: true, vendorKey: 'antigravity',
        modelId: 'agy-local', currentProviderId: 'antigravity',
      });
      expect(screen.getByRole('option', { name: 'Agy Local Model' })).toBeTruthy();
      expect(screen.getByRole('option', { name: 'Agy Studio Model' })).toBeTruthy();
    } finally {
      catalogs.local = originalLocal;
      catalogs.byDevice['device-c'] = originalStudio;
    }
  });
});
