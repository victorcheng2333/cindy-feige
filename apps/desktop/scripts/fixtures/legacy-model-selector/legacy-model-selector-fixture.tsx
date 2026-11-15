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
}] as unknown as ProviderView[];
let cursorLocal = false;
let remoteReads = 0;

void mountPage({
  host: { maker: {
    getModelContextLimit: async () => ({ limit: 200000, isCustomized: false }),
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
    cursorLocal = ctx.case.startsWith('cursor-local');
    (window as unknown as { __remoteModelReads: number }).__remoteModelReads = remoteReads;
    return (
    <main className="flex h-screen items-end justify-end p-6">
      <ModelSelector modelId={cursorLocal ? 'cursor-fixture' : ctx.case === 'compact-selected' ? 'claude-opus-5-5' : modelId} effort="high" vendorKey={cursorLocal ? 'cursor' : 'cc'}
        agentIdentity={{ vendorKey: cursorLocal ? 'cursor' : 'cc', state: 'pending' }}
        currentProviderId={cursorLocal ? 'cursor' : ctx.case === 'compact-selected' ? 'shared-anthropic' : 'tapsvc'} providersOverride={ctx.case === 'compact-selected' ? [{ ...providers[0], models: { codex: [{ id: 'gpt-fixture', name: 'GPT fixture', contextWindow: 200000, efforts: [] }], pi: [{ id: 'pi-fixture', name: 'Pi fixture', contextWindow: 200000, efforts: [] }], 'claude-code': [{ ...providers[0].models['claude-code']![0], id: 'claude-opus-5-5', name: 'Opus 5.5' }] } }] : providers}
        providersOverrideState={{ status: 'ready', refresh: () => {} }}
        onModelChange={() => {}} onEffortChange={() => {}}
        unifiedAgents={ctx.case.startsWith('cursor') ? ['claude-code', 'codex', 'cursor'] : undefined}
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
        agentSwitch={ctx.case.startsWith('compact') && !ctx.case.startsWith('compact-task') ? undefined : { currentVendor: cursorLocal ? 'cursor' : 'cc', onSwitch: async (agent, model, provider) => {
          (window as unknown as { __modelPickerSelection: unknown }).__modelPickerSelection = { agent, model, provider };
          return true;
        } }}
        useMorphPopover={ctx.case !== 'radix'} unifiedPanel={false}
      />
    </main>
    );
  },
});
