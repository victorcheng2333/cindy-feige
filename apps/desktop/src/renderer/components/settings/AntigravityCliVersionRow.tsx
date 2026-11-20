import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { toast } from '@/lib/toast';
import { HARNESS_MENU_ITEM_CLASS, HarnessVersionMenuRow } from './HarnessVersionMenuRow';

export function AntigravityCliVersionRow() {
  const { t } = useTranslation();
  const [version, setVersion] = useState<string | null>();
  const [confirm, setConfirm] = useState(false);
  const [updating, setUpdating] = useState(false);
  const pending = useRef(false);
  const mounted = useRef(false);

  useEffect(() => {
    mounted.current = true;
    const api = window.electronAPI.maker.antigravityCli;
    void (api?.getVersion() ?? Promise.resolve(null)).then(
      value => { if (mounted.current && !pending.current) setVersion(value); },
      () => { if (mounted.current && !pending.current) setVersion(null); },
    );
    return () => { mounted.current = false; };
  }, []);

  async function update() {
    if (pending.current) return;
    pending.current = true;
    setConfirm(false);
    setUpdating(true);
    try {
      const result = await window.electronAPI.maker.antigravityCli.update();
      if (!mounted.current) return;
      if (result.status === 'updated') setVersion(result.version);
      else toast.error(t(result.status === 'busy' ? 'settings.about.agyCli.busy' : 'settings.about.agyCli.failed'));
    } catch {
      if (mounted.current) toast.error(t('settings.about.agyCli.failed'));
    } finally {
      pending.current = false;
      if (mounted.current) setUpdating(false);
    }
  }

  const label = t('settings.about.agyCli.label');
  return <>
    <HarnessVersionMenuRow
      harnessKind="antigravity"
      label={label}
      manageLabel={t('settings.about.harnessManage', { name: 'agy CLI' })}
      version={version ?? t(version === undefined ? 'settings.about.version.loading' : 'settings.about.version.notReady')}
      status={updating ? t('settings.about.cursorSdk.installing') : ''}
      pending={updating}
      testId="antigravity-harness-row"
    >
      <DropdownMenuItem className={HARNESS_MENU_ITEM_CLASS} disabled={!version || updating} onSelect={() => setConfirm(true)}>
        {t('settings.about.agyCli.update')}
      </DropdownMenuItem>
    </HarnessVersionMenuRow>
    <ConfirmDialog open={confirm} onOpenChange={setConfirm}
      title={t('settings.about.agyCli.update')}
      description={t('settings.about.agyCli.description')}
      confirmText={t('settings.about.piKernel.updateConfirm')}
      onConfirm={() => void update()} />
  </>;
}
