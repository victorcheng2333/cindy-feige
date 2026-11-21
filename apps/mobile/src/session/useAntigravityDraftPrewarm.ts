import { useCallback, useEffect, useRef } from 'react';
import type { MobileMakerTransport } from '@/device-link/mobileMakerTransport';
import { buildRemoteCreateSessionOptions, type NewSessionDraft } from './newSession';
import { createNewSessionId } from './newSessionCreation';

function agyDraftKey(draft: NewSessionDraft, planMode?: boolean): string | null {
  if (draft.agentKind !== 'antigravity' ||
      (draft.workspaceKind === 'project' && !draft.workingDir.trim()) || !draft.model.trim() || draft.agentDeviceId ||
      draft.extraDirs?.length) {
    return null;
  }
  return JSON.stringify({ ...buildRemoteCreateSessionOptions(draft), ...(planMode ? { planMode } : {}) });
}

function readDraftReceipt(value: unknown): string | undefined {
  if (!value || typeof value !== 'object' || !('draftSessionId' in value) ||
      !('accepted' in value) || value.accepted !== true ||
      typeof value.draftSessionId !== 'string' || !/^[a-z0-9]{24}$/i.test(value.draftSessionId)) return;
  return value.draftSessionId;
}

export function useAntigravityDraftPrewarm(input: {
  enabled: boolean;
  ownerGeneration: number;
  deviceId: string;
  draft: NewSessionDraft;
  planMode?: boolean;
  maker: Pick<MobileMakerTransport, 'prewarmSession'>;
}) {
  const { enabled, ownerGeneration, deviceId, draft, planMode, maker } = input;
  const key = enabled && draft.firstMessage.trim() ? agyDraftKey(draft, planMode) : null;
  const scope = key ? JSON.stringify([ownerGeneration, deviceId, draft.workspaceKind, draft.workingDir]) : null;
  const prepared = useRef<{ scope: string; key: string; id: string; claimed: boolean } | null>(null);
  const discard = useCallback((id: string) => {
    void maker.prewarmSession(id, { purpose: 'antigravity-draft-discard' }).catch(() => undefined);
  }, [maker]);

  useEffect(() => () => {
    const previous = prepared.current;
    if (previous?.scope !== scope) return;
    if (!previous.claimed) discard(previous.id);
    prepared.current = null;
  }, [discard, scope]);

  useEffect(() => {
    if (!scope || !key) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      const current = prepared.current;
      const reused = current?.scope === scope && !current.claimed ? current.id : undefined;
      const opts = { ...JSON.parse(key), purpose: 'antigravity-draft' };
      const request = async () => {
        let id = readDraftReceipt(await maker.prewarmSession(reused ?? createNewSessionId(), opts));
        if (!id && reused && !cancelled) id = readDraftReceipt(await maker.prewarmSession(createNewSessionId(), opts));
        if (!id) return;
        if (cancelled) {
          if (id !== reused) discard(id);
          return;
        }
        if (reused && reused !== id) discard(reused);
        prepared.current = { scope, key, id, claimed: false };
      };
      void request().catch(() => undefined);
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [discard, key, scope, maker]);

  return useCallback((currentDraft: NewSessionDraft) => {
    const ready = prepared.current;
    if (!scope || !ready || ready.claimed || ready.scope !== scope ||
        ready.key !== key || agyDraftKey(currentDraft, planMode) !== key) return;
    ready.claimed = true;
    return ready.id;
  }, [key, planMode, scope]);
}
