import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SettingsCard, SettingsRow } from '@/components/ui/settings-rows';
import { Switch } from '@/components/ui/switch';
import { toast } from '@/lib/toast';
import { remoteControlSettings } from './RemoteControlSection.settings-search';
import { useSettingDefinition } from './useSettingDefinition';

/** macOS controller preference: open other Macs in system Screen Sharing when reachable. */
export function SystemScreenSharingSetting() {
  const setting = useSettingDefinition(remoteControlSettings.systemScreenSharing);
  const { t } = useTranslation();
  const api = window.electronAPI?.remoteDesktop;
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!api?.systemSharing) return;
    let active = true;
    void api
      .systemSharing()
      .then((value) => {
        if (active) setEnabled(value.enabled);
      })
      .catch(() => {
        if (active) setEnabled(false);
      });
    return () => {
      active = false;
    };
  }, [api]);
  if (window.electronAPI?.platform !== 'darwin' || !api?.systemSharing) return null;
  return (
    <SettingsCard>
      <SettingsRow
        {...setting.anchorProps}
        title={setting.title}
        hint={setting.description}
        trailing={
          <Switch
            {...setting.controlProps}
            aria-label={t('settings.remoteControl.systemSharing.toggleAria')}
            checked={enabled === true}
            disabled={busy || enabled === null}
            onCheckedChange={(next) => {
              setBusy(true);
              void api
                .setSystemSharing(next)
                .then((value) => setEnabled(value.enabled))
                .catch(() => toast.error(t('settings.remoteControl.systemSharing.saveFailed')))
                .finally(() => setBusy(false));
            }}
          />
        }
      />
    </SettingsCard>
  );
}
