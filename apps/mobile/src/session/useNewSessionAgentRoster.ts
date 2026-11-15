import { useEffect, useState } from 'react';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { withTransientRemoteRetry } from '@/device-link/remoteRetry';
import { normalizeMobileAgentCapabilities } from './agentCapabilities';
import type { NewSessionAgentKind } from './newSession';

/** Refresh in place: an unknown roster shows Pi and hides Cursor, so clearing a
 * known roster while revalidating makes the two tabs visibly alternate. */
export function useNewSessionAgentRoster(p: {
  deviceId: string;
  ownerGeneration: number;
  maker: Pick<MobileMakerTransport, 'listAvailableAgents' | 'getCapabilities'>;
  openLink: (deviceId: string) => Promise<unknown>;
  refreshNonce: number;
}): ReadonlySet<NewSessionAgentKind> | null {
  const { deviceId, ownerGeneration, maker, openLink, refreshNonce } = p;
  const scope = JSON.stringify([ownerGeneration, deviceId]);
  const [snapshot, setSnapshot] = useState<{
    scope: string;
    agents: ReadonlySet<NewSessionAgentKind>;
  } | null>(null);

  useEffect(() => {
    if (!deviceId) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    void withTransientRemoteRetry(async () => {
      await openLink(deviceId);
      if (cancelled) return null;
      const agents = await maker.listAvailableAgents();
      if (cancelled) return null;
      if (!agents.includes('cursor')) return agents;
      const cursor = normalizeMobileAgentCapabilities(await maker.getCapabilities('cursor'));
      return cursor?.supportsControlledCursorCreation ? agents : agents.filter(agent => agent !== 'cursor');
    }).then((agents) => {
      if (cancelled || !agents) return;
      setSnapshot({ scope, agents: new Set(agents.filter(
        (agent): agent is NewSessionAgentKind =>
          agent === 'claude-code' || agent === 'codex' || agent === 'pi' || agent === 'cursor',
      )) });
    }).catch(() => {
      // Keep the last successful roster for this owner/device on a transient failure.
      // A new scope stays unknown; it must never inherit another computer's roster.
    });
    return () => { cancelled = true; };
  }, [deviceId, ownerGeneration, scope, maker, openLink, refreshNonce]);

  return deviceId && snapshot?.scope === scope ? snapshot.agents : null;
}
