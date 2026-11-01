// @vitest-environment jsdom
/**
 * 模型面板底部「配置模型」：本机目录与分享来的供应商显示，点分享来的供应商时带上分享 id，
 * 设置页直接选中那一条(provider-sharing.md §5.2)。自己其他电脑与被控电脑上的目录要到那台电脑上改，不显示。
 */
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

vi.mock('@/hooks/useAgentCapabilities', () => ({
  evictDeviceCapabilities: vi.fn(),
  prefetchDeviceCapabilities: vi.fn(async () => {}),
  useAgentCapabilities: () => ({
    capabilities: { hasFastMode: false, effortLevels: [], availableModels: [] },
    loading: false,
    error: null,
  }),
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
    local: [provider('a-local', 'A Local', 'a-model')] as unknown[],
    byDevice: {
      'device-b': [provider('b-main', 'B Main', 'b-model')],
      'device-c': [provider('c-open', 'C Open', 'c-model', { remoteInvocationEnabled: true })],
      'share:abc': [provider('s-shared', 'S Shared', 's-model', { remoteInvocationEnabled: true })],
    } as Record<string, unknown[]>,
  };
});

vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: catalogs.local, providerOrder: [] }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  evictDeviceProviders: vi.fn(),
  prefetchDeviceProviders: vi.fn(async () => {}),
  useDeviceProviders: (deviceId?: string) => ({
    providers: deviceId ? (catalogs.byDevice[deviceId] ?? []) : [],
    loading: false,
    error: null,
    unsupported: false,
  }),
}));
vi.mock('@/hooks/useDevicesProviders', () => ({
  useDevicesProviders: (deviceIds: readonly string[]) =>
    new Map(
      deviceIds.map((deviceId) => [
        deviceId,
        { providers: catalogs.byDevice[deviceId] ?? [], loading: false, error: null },
      ]),
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
import { __resetForTest as resetEnginePrefs } from '@/state/modelEnginePrefs';
import { __resetForTest as resetFavorites } from '@/state/modelFavorites';

const studio = { deviceId: 'device-c', name: 'Studio' };
const share = { deviceId: 'share:abc', name: '来自 Magi 的分享' };
const SHARE_CELL = 'S Shared · 来自 Magi 的分享';
const ENTRY = 'newChat.modelSelector.source.connect';

type Props = React.ComponentProps<typeof ModelSelectorContent>;

function renderPanel(
  remoteAgent: Partial<NonNullable<Props['remoteAgent']>> = {},
  props: Partial<Props> = {},
) {
  const onNavigateToProviders = vi.fn();
  render(
    React.createElement(ModelSelectorContent, {
      // This suite exercises the retained unified panel's source rail.
      unifiedPanel: true,
      modelId: 'a-model',
      effort: 'high',
      onModelChange: vi.fn(),
      onEffortChange: vi.fn(),
      currentProviderId: 'a-local',
      onProviderChange: vi.fn(),
      onUnifiedSelect: vi.fn(async () => true),
      vendorKey: 'cc',
      onNavigateToProviders,
      remoteAgent: { devices: [studio, share], selectedDeviceId: null, ...remoteAgent },
      ...props,
    }),
  );
  return { onNavigateToProviders };
}

async function browse(name: string) {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name }));
  });
}

beforeEach(() => {
  HTMLElement.prototype.scrollIntoView = vi.fn();
  resetEnginePrefs();
  resetFavorites();
});

afterEach(() => {
  cleanup();
});

describe('模型面板底部「配置模型」', () => {
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
