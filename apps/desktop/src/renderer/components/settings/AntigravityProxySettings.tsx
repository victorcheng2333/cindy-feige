import { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { extractIpcError } from '@/utils/ipcError';
import { SettingsTextInput } from './SettingsTextInput';

export function AntigravityProxySettings({ onChanged, ownerId, generation }: { onChanged: () => void; ownerId: string | null; generation: number | null }) {
  const { t } = useTranslation();
  const inputId = useId();
  const [saved, setSaved] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<'readFailed' | 'invalid' | 'saveFailed' | 'saved' | null>(null);

  useEffect(() => {
    let current = true;
    void window.electronAPI.maker.auth.getAgyProxy().then(address => {
      if (!current) return;
      setSaved(address);
      setDraft(address);
    }).catch(() => { if (current) setMessage('readFailed'); });
    return () => { current = false; };
  }, []);

  async function save() {
    if (saved === null || busy || draft.trim() === saved) return;
    setBusy(true);
    setMessage(null);
    try {
      const address = await window.electronAPI.maker.auth.setAgyProxy(draft, ownerId, generation);
      setSaved(address);
      setDraft(address);
      setMessage('saved');
      onChanged();
    } catch (error) {
      setMessage(extractIpcError(error)?.code === 'INVALID_PARAMS' ? 'invalid' : 'saveFailed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="flex flex-col gap-2" onSubmit={event => { event.preventDefault(); void save(); }}>
      <label htmlFor={inputId} className="text-14 font-medium text-[var(--text-primary)]">
        {t('settings.providers.agyProxy.label')}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <SettingsTextInput
          data-settings-search-action="Enter the Agy network proxy address in the provider settings"
          id={inputId}
          value={draft}
          onChange={value => { setDraft(value); setMessage(null); }}
          placeholder="http://127.0.0.1:7890"
          size="sm"
          mono
          autoComplete="off"
          disabled={saved === null || busy}
          className="min-w-0 flex-1"
        />
        <Button
          data-settings-search-action="Save the Agy network proxy address in the provider settings"
          type="submit"
          variant="secondary"
          size="sm"
          disabled={saved === null || busy || draft.trim() === saved}
        >
          {t('settings.providers.agyProxy.save')}
        </Button>
      </div>
      <p className="text-12 text-[var(--text-secondary)]">{t('settings.providers.agyProxy.hint')}</p>
      {message && <p role={message === 'saved' ? 'status' : 'alert'} className="text-12 text-[var(--text-primary)]">
        {t(`settings.providers.agyProxy.${message}`)}
      </p>}
    </form>
  );
}
