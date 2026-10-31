import { useState } from 'react';
import { BUNDLED_CATALOG, buildUserProvider, type CustomProviderConfig, type ProviderView } from '@cindy/model-providers';
import { mountPage, subscription } from '../../ui-page/harness';
import { GenericOAuthHeader } from '../../../src/renderer/components/settings/ProvidersSection';
import { beginProvidersRefresh, commitProvidersSnapshot } from '../../../src/renderer/lib/providersSnapshotStore';
import { getDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { AddProviderWizard } from '../../../src/renderer/components/settings/AddProviderWizard';
import { getToastSnapshot } from '../../../src/renderer/lib/toast';

// The isolated preview uses an insecure custom origin; packaged Cindy exposes
// Web Crypto randomUUID. Supply that browser API here, without replacing app logic.
if (!crypto.randomUUID) Object.defineProperty(crypto, 'randomUUID', { value: () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
} });

let secondConnected = false;
const calls: string[] = [];
const created: CustomProviderConfig[] = [];
Object.assign(window, { claudeWizardEvidence: { created, calls }, claudeWizardToasts: getToastSnapshot });
const builtin = { ...BUNDLED_CATALOG.providers.find(provider => provider.id === 'anthropic')!, connected: true } as ProviderView;
function providers(): ProviderView[] {
  return ['claude-a', 'claude-b'].map((id, index) => ({
    ...buildUserProvider({ id, name: index ? 'Claude · Personal' : 'Claude · Work',
      auth: { method: 'oauth', native: 'claude' }, runtimes: {} }),
    connected: index === 0 || secondConnected,
    subscriptionAccount: { source: 'oauth', identity: `sample-${index}@example.com` },
  } as ProviderView));
}

function Fixture({ wizard = false }: { wizard?: boolean }) {
  const [, refresh] = useState(0);
  const [completed, setCompleted] = useState<string[]>([]);
  if (wizard) return <main className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]">
    <AddProviderWizard key={completed.length} providers={[builtin, ...providers()]}
      entry={{ kind: 'builtin', providerId: 'anthropic' }} onClose={() => {}} onOpenCustomForm={() => {}}
      onDone={id => setCompleted(values => [...values, id])} />
    <output hidden data-testid="wizard-result">{JSON.stringify({ completed, created, calls })}</output>
  </main>;
  return <main className="min-h-screen bg-[var(--surface)] p-4 text-[var(--text-primary)]">
    <div className="flex flex-wrap gap-4">
      {providers().map(provider => <section key={provider.id} data-testid={provider.id}
        className="flex min-h-[520px] min-w-0 flex-1 basis-[360px] flex-col rounded-lg border border-[var(--border-default)] bg-[var(--settings-theme-card-bg)]">
        <GenericOAuthHeader provider={provider} onChanged={() => refresh(value => value + 1)} />
      </section>)}
    </div>
    <output hidden data-testid="account-actions">{calls.join(',')}</output>
  </main>;
}

void mountPage({
  host: () => {
    const owner = getDataOwnerGeneration();
    const snapshot = () => ({ dataOwnerId: owner.dataOwnerId, ownerGeneration: owner.generation,
      providers: providers(), providerOrder: ['claude-a', 'claude-b'] });
    commitProvidersSnapshot(beginProvidersRefresh(), snapshot());
    return { maker: {
      listProviders: async () => snapshot(),
      onProvidersChanged: subscription('providers'),
      providerOAuthLogin: async (id: string) => { calls.push(`login:${id}`); secondConnected = true; return { ok: true }; },
      providerOAuthCancel: async () => {},
      providerOAuthLogout: async (id: string) => { calls.push(`disconnect:${id}`); secondConnected = false; return { ok: true }; },
      createCustomProvider: async (config: CustomProviderConfig) => { created.push(config); return { ok: true }; },
      deleteCustomProvider: async () => ({ ok: true }),
      claudeOAuthLogin: async () => { calls.push('login:system'); return { ok: true }; },
      claudeOAuthCancel: async () => {},
      listProviderPresets: async () => ({ presets: [] }),
      localModelList: async () => ({ status: { kind: 'absent', appInstalled: false }, models: [], memoryGb: 0 }),
      scanLocalCli: async () => ({ detections: [] }),
      onProviderOAuthProgress: subscription('providerOAuthProgress'),
      usage: {
        getAccount: async () => null,
        getClaudeSubscription: async (id: string) => ({ providerId: id, subscriptionType: id === 'claude-a' ? 'max' : 'pro',
          updatedAt: Date.now(), sevenDay: { utilization: id === 'claude-a' ? 20 : 80, resetsAt: Math.floor(Date.now() / 1000) + 86400 } }),
        onClaudeSubscriptionChanged: subscription('claude-usage'),
        onCodexAccountChanged: subscription('codex-unused'),
      },
    } };
  },
  render: ctx => <Fixture wizard={ctx.case === 'wizard'} />,
});
