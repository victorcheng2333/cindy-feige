import { useEffect, useState, type ComponentProps } from 'react';
import { mountPage, subscription } from '../../ui-page/harness';
import { ModelSelector } from '../../../src/renderer/components/new-chat/ModelSelector';
import type { ProviderView } from '@cindy/model-providers';

const modelId = 'moonshotai/kimi-k3.1-pro-highspeed';
const providers = [{
  id: 'tapsvc', name: 'TapSVC', source: 'custom', agents: ['claude-code', 'codex', 'pi'],
  auth: { method: 'api-key' }, routing: { 'claude-code': {}, codex: {}, pi: {} }, connected: true,
  models: { codex: [{ id: 'gpt-fixture', name: 'GPT fixture', contextWindow: 200000, efforts: [] }], pi: [{ id: 'pi-fixture', name: 'Pi fixture', contextWindow: 200000, efforts: [] }], 'claude-code': [{
    id: modelId, name: modelId, group: 'custom', contextWindow: 200000,
    efforts: ['low', 'medium', 'high'], defaultEffort: 'high',
  }] },
}, {
  id: 'cursor', name: 'Cursor', source: 'custom', agents: ['cursor'],
  auth: { method: 'api-key' }, routing: { cursor: {} }, connected: true,
  models: { cursor: [{ id: 'cursor-fixture', name: 'Cursor fixture', contextWindow: 200000, efforts: [] }] },
}, {
  id: 'antigravity', name: 'Antigravity', source: 'builtin', agents: ['antigravity'],
  auth: { method: 'oauth' }, routing: { antigravity: {} }, connected: true,
  models: { antigravity: [{ id: 'agy-fixture', name: 'Antigravity fixture', contextWindow: 0, efforts: ['low', 'medium', 'high'], defaultEffort: 'high' }] },
}] as unknown as ProviderView[];
// The parent owns per-Harness draft memory, as NewMakerDraftRoute does.
function DraftModelSelector(props: ComponentProps<typeof ModelSelector>) {
  const [vendor, setVendor] = useState<'cc' | 'codex' | 'pi' | 'cursor' | 'antigravity'>('cc');
  const rememberedModels = { cc: modelId, codex: 'gpt-fixture', pi: 'pi-fixture', cursor: 'cursor-fixture', antigravity: 'agy-fixture' };
  return <ModelSelector {...props} vendorKey={vendor} modelId={rememberedModels[vendor]}
    currentProviderId={vendor === 'cursor' || vendor === 'antigravity' ? vendor : 'tapsvc'}
    agentIdentity={{ vendorKey: vendor, state: 'current' }} onDraftVendorChange={setVendor} />;
}

let restoreAgyFixtureModels: (() => void) | undefined;
function TaskAgyModelSelector(props: ComponentProps<typeof ModelSelector>) {
  const [recovered, setRecovered] = useState(false);
  useEffect(() => {
    restoreAgyFixtureModels = () => setRecovered(true);
    return () => { restoreAgyFixtureModels = undefined; };
  }, []);
  const catalog = recovered ? props.providersOverride?.map(provider =>
    provider.id === 'antigravity' ? providers[2] : provider,
  ) : props.providersOverride;
  return <ModelSelector {...props} providersOverride={catalog} />;
}

const speedProviders: ProviderView[] = [{
  ...providers[0],
  models: {
    codex: [
      { ...providers[0].models.codex![0], supportsFastMode: true, supportsUltrafastMode: true },
      { ...providers[0].models.codex![0], id: 'gpt-fast-only', name: 'GPT Fast only', supportsFastMode: true },
    ],
  },
}];

function SpeedModelSelector() {
  const [fastMode, setFastMode] = useState<boolean | 'ultrafast'>(false);
  return (
    <ModelSelector
      modelId="gpt-fixture"
      effort="high"
      vendorKey="codex"
      currentProviderId="tapsvc"
      remoteAgent={undefined}
      providersOverride={speedProviders}
      providersOverrideState={{ status: 'ready', refresh: () => {} }}
      fastMode={fastMode}
      onFastModeChange={setFastMode}
      onModelChange={() => {}}
      onProviderChange={() => {}}
      onEffortChange={() => {}}
      compactProviderList
      unifiedPanel={false}
      useMorphPopover
    />
  );
}

let cursorLocal = false;
let remoteReads = 0;

void mountPage({
  host: { maker: {
    getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
    getCapabilities: async (agent: string) => ({
      availableModels: [], effortLevels: [], permissionModes: [], hasFastMode: agent === 'codex',
    }),
    rediscoverModels: async (providerId: string) => {
      if (providerId !== 'antigravity' || !restoreAgyFixtureModels) throw new Error('Unexpected discovery');
      restoreAgyFixtureModels();
      return { ok: true };
    },
    onProvidersChanged: subscription('providersChanged'),
  }, deviceLink: {
    invoke: async (_deviceId: string, channel: string) => {
      (window as unknown as { __remoteModelReads: number }).__remoteModelReads = ++remoteReads;
      if (cursorLocal) throw new Error('DEVICE_LINK_UNREACHABLE');
      if (channel === 'maker:provider:list') return { providers: [{ ...providers[0], id: 'shared-anthropic', name: _deviceId === 'device-fixture' ? 'Anthropic-6' : 'Anthtopic-6', remoteInvocationEnabled: true,
        models: { codex: [{ id: 'gpt-fixture', name: 'GPT fixture', contextWindow: 200000, efforts: [] }], pi: [{ id: 'pi-fixture', name: 'Pi fixture', contextWindow: 200000, efforts: [] }], 'claude-code': [{ id: 'claude-opus-5-5', name: 'Opus 5.5', contextWindow: 1000000, efforts: ['low', 'high'], defaultEffort: 'high' }] },
      }] };
      if (channel === 'maker:get-capabilities') return { availableModels: [], effortLevels: [], permissionModes: [], hasFastMode: false };
      return null;
    },
  } },
  render: ctx => {
    if (ctx.case.startsWith('speed')) {
      return <main className="flex h-screen items-end justify-end p-6"><SpeedModelSelector /></main>;
    }
    const taskHeight = ctx.case.startsWith('compact-task-agy-height');
    const Picker = taskHeight ? TaskAgyModelSelector : ctx.case.startsWith('compact-draft') ? DraftModelSelector : ModelSelector;
    const taskHeightProviders = taskHeight ? providers.map(provider =>
      provider.id === 'tapsvc'
        ? { ...provider, models: { codex: Array.from({ length: 12 }, (_, index) => ({
          ...provider.models.codex![0],
          id: index === 0 ? 'gpt-fixture' : `gpt-fixture-${index}`,
          name: `GPT fixture ${index + 1}`,
        })) } }
        : provider.id === 'antigravity'
          ? { ...provider, connected: false, models: { antigravity: [] },
            modelDiscoveryFailure: { kind: 'unauthorized' as const, at: '2026-11-20T00:00:00.000Z' } }
          : provider,
    ) : undefined;
    cursorLocal = ctx.case.startsWith('cursor-local');
    const currentVendor = cursorLocal ? 'cursor' : taskHeight ? 'codex' : 'cc';
    (window as unknown as { __remoteModelReads: number }).__remoteModelReads = remoteReads;
    return (
    <main className="flex h-screen items-end justify-end p-6">
      <Picker modelId={cursorLocal ? 'cursor-fixture' : taskHeight ? 'gpt-fixture' : ctx.case === 'compact-selected' ? 'claude-opus-5-5' : modelId} effort="high" vendorKey={currentVendor}
        agentIdentity={{ vendorKey: currentVendor, state: ctx.case.startsWith('compact-draft') ? 'current' : 'pending' }}
        currentProviderId={cursorLocal ? 'cursor' : ctx.case === 'compact-selected' ? 'shared-anthropic' : 'tapsvc'} providersOverride={taskHeightProviders ?? (ctx.case === 'compact-selected' ? [{ ...providers[0], models: { codex: [{ id: 'gpt-fixture', name: 'GPT fixture', contextWindow: 200000, efforts: [] }], pi: [{ id: 'pi-fixture', name: 'Pi fixture', contextWindow: 200000, efforts: [] }], 'claude-code': [{ ...providers[0].models['claude-code']![0], id: 'claude-opus-5-5', name: 'Opus 5.5' }] } }] : providers)}
        providersOverrideState={{ status: 'ready', refresh: () => {} }}
        onModelChange={() => {}} onEffortChange={() => {}}
        draftEngineTabs={ctx.case.startsWith('compact-draft')}
        unifiedAgents={taskHeight || ctx.case.startsWith('compact-draft-antigravity') ? ['claude-code', 'codex', 'pi', 'cursor', 'antigravity'] : ctx.case.startsWith('compact-draft-height') ? ['claude-code', 'codex', 'cursor'] : ctx.case.startsWith('compact-draft') ? ['claude-code', 'codex'] : ctx.case.startsWith('cursor') ? ['claude-code', 'codex', 'cursor'] : undefined}
        {...(ctx.case.startsWith('cursor') ? { onProviderChange: () => {} } : {})}
        {...((ctx.case === 'shared' || ctx.case.startsWith('compact') || ctx.case.startsWith('cursor')) ? {
          onProviderChange: () => {},
          remoteAgent: { devices: [...(ctx.case.startsWith('compact') || ctx.case.startsWith('cursor') ? [{ deviceId: 'device-fixture', name: 'M5-Mac' }] : []), { deviceId: 'share:fixture', name: '来自测试用户的分享' }], selectedDeviceId: ctx.case === 'compact-selected' || (ctx.case.startsWith('cursor') && !cursorLocal) ? 'device-fixture' : null, onRelocate: async (selection) => {
            (window as unknown as { __modelPickerRelocation: unknown }).__modelPickerRelocation = selection;
            return true;
          } },
        } : {})}
        {...(ctx.case.startsWith('cursor') ? { compactProviderList: true } : {})}
        {...(ctx.case.startsWith('compact') ? {
          compactProviderList: true,
          onNavigateToProviders: () => {},
          onUnifiedSelect: ctx.case.startsWith('compact-task') ? undefined : async (selection: unknown) => {
            (window as unknown as { __modelPickerSelection: unknown }).__modelPickerSelection = selection;
            return true;
          },
        } : {})}
        agentSwitch={ctx.case.startsWith('compact') && !ctx.case.startsWith('compact-task') ? undefined : { currentVendor, onSwitch: async (agent, model, provider) => {
          (window as unknown as { __modelPickerSelection: unknown }).__modelPickerSelection = { agent, model, provider };
          return true;
        } }}
        useMorphPopover={ctx.case !== 'radix'} unifiedPanel={false}
      />
    </main>
    );
  },
});
