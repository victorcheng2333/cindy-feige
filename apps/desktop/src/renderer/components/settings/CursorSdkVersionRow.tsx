import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CursorSdkInstallRequest, CursorSdkState } from '../../../shared/cursorSdk';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { HARNESS_MENU_ITEM_CLASS, HarnessMenuFootnote, HarnessVersionMenuItem, HarnessVersionMenuRow } from './HarnessVersionMenuRow';
import { toast } from '@/lib/toast';

/** Reads local state on opening; network checks only follow an explicit click. */
export function CursorSdkVersionRow() {
  const { t, i18n } = useTranslation();
  const k = (key: string) => t(`settings.about.cursorSdk.${key}`);
  const [state, setState] = useState<CursorSdkState | null>(null);
  const [busy, setBusy] = useState<'checking' | 'installing' | null>(null);
  const [failed, setFailed] = useState(false);
  const [target, setTarget] = useState<CursorSdkInstallRequest | null>(null);
  const mounted = useRef(false);
  const pending = useRef(false);
  const sequence = useRef(0);
  const refresh = async (check = false) => {
    if (pending.current) return;
    pending.current = true;
    const generation = ++sequence.current;
    if (check) setBusy('checking');
    try {
      const next = await window.electronAPI.maker.cursorSdk.getState(check);
      if (mounted.current && generation === sequence.current) { setState(next); setFailed(false); }
    } catch { if (mounted.current && generation === sequence.current) setFailed(true); }
    finally {
      pending.current = false;
      if (mounted.current) setBusy(null);
    }
  };
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    return () => { mounted.current = false; window.removeEventListener('focus', focus); };
  }, []);

  const install = async () => {
    if (!target || pending.current) return;
    const request = target;
    pending.current = true; ++sequence.current;
    setTarget(null); setBusy('installing');
    try {
      const next = await window.electronAPI.maker.cursorSdk.install(request);
      if (mounted.current) { setState(next); setFailed(false); }
      toast.success(k('installed'));
    } catch {
      if (mounted.current) setFailed(true);
      toast.error(k('installFailed'));
    } finally {
      pending.current = false;
      if (mounted.current) { setBusy(null); void refresh(); }
    }
  };
  const blocked = !!busy || !!state?.operation;
  const status = busy === 'checking' ? k('checking') : busy === 'installing' || state?.operation ? k('installing')
    : failed || state?.checkFailed ? k('checkFailed') : state?.updateAvailable ? k('available') : '';
  return <>
    <HarnessVersionMenuRow harnessKind="cursor" label={k('label')} manageLabel={k('manage')} testId="cursor-harness-row"
      version={state?.currentVersion ?? t(`settings.about.version.${failed ? 'unknown' : state ? 'notReady' : 'loading'}`)}
      status={status} pending={blocked}>
      <HarnessVersionMenuItem label={k('update')} version={state?.latestVersion} disabled={blocked || failed || !state?.updateAvailable}
        onSelect={() => { if (state?.latestVersion) setTarget({ source: 'upstream', version: state.latestVersion }); }} />
      <HarnessVersionMenuItem label={k('restore')} version={state?.bundledVersion} disabled={blocked || state?.source === 'bundled'}
        onSelect={() => setTarget({ source: 'bundled' })} />
      <DropdownMenuSeparator />
      <DropdownMenuItem className={HARNESS_MENU_ITEM_CLASS} disabled={blocked} onSelect={() => void refresh(true)}>{k('check')}</DropdownMenuItem>
      <HarnessMenuFootnote>{k('scope')}</HarnessMenuFootnote>
      {state?.checkedAt && <HarnessMenuFootnote>{t('settings.about.cursorSdk.checkedAt', { time: new Date(state.checkedAt).toLocaleString(i18n.language) })}</HarnessMenuFootnote>}
    </HarnessVersionMenuRow>
    <ConfirmDialog open={!!target} onOpenChange={open => { if (!open) setTarget(null); }}
      title={target?.source === 'upstream' ? t('settings.about.cursorSdk.updateTitle', { version: target.version }) : k('restoreTitle')}
      description={k('description')} confirmText={target?.source === 'bundled' ? k('restore') : k('update')}
      onConfirm={() => void install()} />
  </>;
}
