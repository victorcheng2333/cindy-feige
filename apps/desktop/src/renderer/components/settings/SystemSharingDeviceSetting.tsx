import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Select } from '@/components/ui/select';
import { toast } from '@/lib/toast';
import {
  isSystemScreenSharingPreference,
  type SystemSharingDeviceSettings,
} from '../../../shared/remoteDesktopViewer';
import { useSettingsSearchNavigation } from './SettingsSearchNavigation';
import { remoteControlSettings } from './RemoteControlSection.settings-search';

/** The initiating Mac owns this preference; editing never writes to the other Mac. */
export function SystemSharingDeviceSetting({ deviceId }: { deviceId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<SystemSharingDeviceSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const open = useRef(false);
  const refreshRef = useRef(() => {});
  const generation = useRef(0);
  const saving = useRef(false);
  const readSettings = window.electronAPI?.remoteDesktop?.systemSharingDevice;
  const details = useRef<HTMLDetailsElement>(null);
  const navigation = useSettingsSearchNavigation();
  useEffect(() => {
    if (navigation.entry?.id === remoteControlSettings.systemSharingDevice.id && details.current)
      details.current.open = true;
  }, [navigation.entry, navigation.activation]);
  useEffect(() => {
    let active = true;
    const refresh = () => {
      if (!active || !open.current || saving.current || !readSettings) return;
      const current = ++generation.current;
      void readSettings(deviceId)
        .then((value) => {
          if (generation.current === current) setState(value);
        })
        .catch(() => {});
    };
    setBusy(false);
    saving.current = false;
    setState(null);
    refreshRef.current = refresh;
    refresh();
    window.addEventListener('focus', refresh);
    window.addEventListener('system-sharing-settings-changed', refresh);
    return () => {
      active = false;
      generation.current++;
      window.removeEventListener('focus', refresh);
      window.removeEventListener('system-sharing-settings-changed', refresh);
    };
  }, [readSettings, deviceId]);
  if (!readSettings) return null;
  const last = state?.lastDecision;
  return (
    <details
      ref={details}
      className="mt-3 text-12 text-[var(--text-secondary)]"
      onToggle={(event) => {
        open.current = event.currentTarget.open;
        if (open.current) refreshRef.current();
      }}
    >
      <summary className="cursor-pointer py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--focus-ring)]">
        {t('remoteDesktop.systemSharing.deviceTitle')}
      </summary>
      <div className="flex flex-col gap-2 pb-1">
        <p>{t('remoteDesktop.systemSharing.deviceHint')}</p>
        <Select
          data-setting-id={remoteControlSettings.systemSharingDevice.id}
          label={t('remoteDesktop.systemSharing.deviceTitle')}
          value={state?.override ?? 'inherit'}
          disabled={busy || !state}
          options={[
            { value: 'inherit', label: t('remoteDesktop.systemSharing.inherit') },
            { value: 'auto', label: t('remoteDesktop.systemSharing.auto') },
            { value: 'high', label: t('remoteDesktop.systemSharing.high') },
            { value: 'standard', label: t('remoteDesktop.systemSharing.standard') },
          ]}
          onValueChange={(value) => {
            if (value !== 'inherit' && !isSystemScreenSharingPreference(value)) return;
            const current = ++generation.current;
            setBusy(true);
            saving.current = true;
            void readSettings(deviceId, value === 'inherit' ? null : value)
              .then((next) => {
                if (current === generation.current) setState(next);
              })
              .catch(() => toast.error(t('settings.remoteControl.systemSharing.saveFailed')))
              .finally(() => {
                if (current === generation.current) {
                  setBusy(false);
                  saving.current = false;
                }
              });
          }}
        />
        {state && (
          <p>
            {t('remoteDesktop.systemSharing.effective', {
              mode: t(`remoteDesktop.systemSharing.${state.effective}`),
            })}
          </p>
        )}
        {state?.enabled === false && <p>{t('remoteDesktop.systemSharing.disabledHint')}</p>}
        {last && (
          <p>
            {t('remoteDesktop.systemSharing.lastChoice', {
              mode: t(`remoteDesktop.systemSharing.${last.mode}`),
              reason: t(`remoteDesktop.systemSharing.reasons.${last.reason}`),
            })}
          </p>
        )}
      </div>
    </details>
  );
}
