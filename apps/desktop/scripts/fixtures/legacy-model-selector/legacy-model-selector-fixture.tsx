import { mountPage, subscription } from '../../ui-page/harness';
import { ModelSelector } from '../../../src/renderer/components/new-chat/ModelSelector';
import type { ProviderView } from '@cindy/model-providers';

const modelId = 'moonshotai/kimi-k3.1-pro-highspeed';
const providers = [{
  id: 'tapsvc', name: 'TapSVC', source: 'custom', agents: ['claude-code'],
  auth: { method: 'api-key' }, routing: { 'claude-code': {} }, connected: true,
  models: { 'claude-code': [{
    id: modelId, name: modelId, group: 'custom', contextWindow: 200000,
    efforts: ['low', 'medium', 'high'], defaultEffort: 'high',
  }] },
}] as unknown as ProviderView[];

void mountPage({
  host: { maker: {
    getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
    onProvidersChanged: subscription('providersChanged'),
  }, deviceLink: {
    invoke: async (_deviceId: string, channel: string) => {
      if (channel === 'maker:provider:list') return { providers: [{ ...providers[0], id: 'shared-anthropic', name: _deviceId === 'device-fixture' ? 'Anthropic-6' : 'Anthtopic-6', remoteInvocationEnabled: true,
        models: { 'claude-code': [{ id: 'claude-opus-5-5', name: 'Opus 5.5', contextWindow: 1000000, efforts: ['low', 'high'], defaultEffort: 'high' }] },
      }] };
      if (channel === 'maker:get-capabilities') return { availableModels: [], effortLevels: [], permissionModes: [], hasFastMode: false };
      return null;
    },
  } },
  render: ctx => (
    <main className="flex h-screen items-end justify-end p-6">
      <ModelSelector modelId={ctx.case === 'compact-selected' ? 'claude-opus-5-5' : modelId} effort="high" vendorKey="cc"
        agentIdentity={{ vendorKey: 'cc', state: 'pending' }}
        currentProviderId={ctx.case === 'compact-selected' ? 'shared-anthropic' : 'tapsvc'} providersOverride={ctx.case === 'compact-selected' ? [{ ...providers[0], models: { 'claude-code': [{ ...providers[0].models['claude-code']![0], id: 'claude-opus-5-5', name: 'Opus 5.5' }] } }] : providers}
        providersOverrideState={{ status: 'ready', refresh: () => {} }}
        onModelChange={() => {}} onEffortChange={() => {}}
        {...((ctx.case === 'shared' || ctx.case.startsWith('compact')) ? {
          onProviderChange: () => {},
          remoteAgent: { devices: [...(ctx.case.startsWith('compact') ? [{ deviceId: 'device-fixture', name: 'M5-Mac' }] : []), { deviceId: 'share:fixture', name: '来自测试用户的分享' }], selectedDeviceId: ctx.case === 'compact-selected' ? 'device-fixture' : null, onRelocate: async () => true },
        } : {})}
        {...(ctx.case.startsWith('compact') ? {
          compactProviderList: true,
          onNavigateToProviders: () => {},
          onUnifiedSelect: async (selection: unknown) => {
            (window as unknown as { __modelPickerSelection: unknown }).__modelPickerSelection = selection;
            return true;
          },
        } : {})}
        agentSwitch={{ currentVendor: 'cc', onSwitch: async () => {} }}
        useMorphPopover={ctx.case !== 'radix'} unifiedPanel={false}
      />
    </main>
  ),
});
