import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AntigravityCliState } from '../../../shared/antigravityCli';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import { HARNESS_MENU_ITEM_CLASS, HarnessMenuFootnote, HarnessVersionMenuItem, HarnessVersionMenuRow } from './HarnessVersionMenuRow';

interface AgyCliViewState extends AntigravityCliState {
  loading: boolean;
  checking: boolean;
}

const INITIAL: AgyCliViewState = {
  loading: true,
  version: null,
  latestVersion: null,
  updateAvailable: false,
  checkedAt: null,
  checkFailed: false,
  checking: false,
};

export function AntigravityCliVersionRow() {
  const { t, i18n } = useTranslation();
  const [state, setState] = useState<AgyCliViewState>(INITIAL);
  const [confirm, setConfirm] = useState(false);
  const [updating, setUpdating] = useState(false);
  const updatingRef = useRef(false);
  const checkPending = useRef(false);
  const mounted = useRef(false);

  const check = useCallback(() => {
    if (checkPending.current || updatingRef.current) return;
    const api = window.electronAPI.maker.antigravityCli;
    if (!api?.getState) return;
    checkPending.current = true;
    setState(prev => ({ ...prev, checking: true }));
    void api
      .getState(true)
      .then(
        next => {
          if (!mounted.current || updatingRef.current) return;
          setState({ ...next, loading: false, checking: false });
        },
        () => {
          if (mounted.current && !updatingRef.current) {
            setState(prev => ({ ...prev, loading: false, checking: false, checkFailed: true, updateAvailable: false }));
          }
        },
      )
      .finally(() => {
        checkPending.current = false;
      });
  }, []);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const api = window.electronAPI.maker.antigravityCli;
    const readLocal = api?.getState
      ? api.getState(false)
      : (api?.getVersion() ?? Promise.resolve(null)).then<AntigravityCliState>(version => ({
          version,
          latestVersion: null,
          updateAvailable: false,
          checkedAt: null,
          checkFailed: false,
        }));
    void readLocal
      .then(
        next => {
          if (cancelled || updatingRef.current) return null;
          setState(prev => ({ ...prev, ...next, loading: false }));
          return next;
        },
        () => {
          if (cancelled || updatingRef.current) return null;
          setState(prev => ({ ...prev, loading: false, version: null }));
          return null;
        },
      )
      .then(local => {
        if (!cancelled && local?.version) check();
      });
    return () => {
      cancelled = true;
      mounted.current = false;
    };
  }, [check]);

  async function update() {
    if (updatingRef.current || checkPending.current || !state.updateAvailable) return;
    updatingRef.current = true;
    setConfirm(false);
    setUpdating(true);
    try {
      const result = await window.electronAPI.maker.antigravityCli.update();
      if (!mounted.current) return;
      if (result.status === 'updated') {
        const next = await window.electronAPI.maker.antigravityCli.getState?.(false).catch(() => null);
        if (!mounted.current) return;
        setState(prev => next
          ? { ...next, version: result.version, loading: false, checking: false }
          : { ...prev, version: result.version, updateAvailable: false, loading: false, checking: false });
      } else {
        toast.error(t(result.status === 'busy' ? 'settings.about.agyCli.busy' : 'settings.about.agyCli.failed'));
      }
    } catch {
      if (mounted.current) toast.error(t('settings.about.agyCli.failed'));
    } finally {
      updatingRef.current = false;
      if (mounted.current) setUpdating(false);
    }
  }

  const updateAvailable = Boolean(!state.checking && !state.checkFailed && state.version && state.latestVersion && state.updateAvailable);
  const status = updating
    ? t('settings.about.cursorSdk.installing')
    : state.checking
      ? t('settings.about.harnessChecking')
      : state.checkFailed
        ? t('settings.about.harnessCheckFailed')
        : updateAvailable
          ? t('settings.about.harnessUpdateAvailable')
          : '';
  const versionText = state.loading
    ? t('settings.about.version.loading')
    : state.version ?? t('settings.about.version.notReady');

  return <>
    <HarnessVersionMenuRow
      harnessKind="antigravity"
      label={t('settings.about.agyCli.label')}
      manageLabel={t('settings.about.harnessManage', { name: 'Agy CLI' })}
      version={versionText}
      status={status}
      pending={state.checking || updating}
      testId="antigravity-harness-row"
    >
      <HarnessVersionMenuItem
        label={t('settings.about.agyCli.update')}
        version={state.latestVersion}
        disabled={!updateAvailable || updating}
        onSelect={() => setConfirm(true)}
      />
      <DropdownMenuSeparator />
      <DropdownMenuItem
        className={HARNESS_MENU_ITEM_CLASS}
        disabled={!state.version || state.checking || updating}
        onSelect={check}
      >
        {state.checking ? t('settings.about.harnessChecking') : t('settings.about.harnessCheck')}
      </DropdownMenuItem>
      {state.checkedAt && (
        <HarnessMenuFootnote>
          {t('settings.about.harnessCheckedAt', { time: new Date(state.checkedAt).toLocaleString(i18n.language) })}
        </HarnessMenuFootnote>
      )}
    </HarnessVersionMenuRow>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm}
      title={t('settings.about.agyCli.update')}
      description={t('settings.about.agyCli.description')}
      confirmText={t('settings.about.piKernel.updateConfirm')}
      onConfirm={() => void update()} />
  </>;
}
