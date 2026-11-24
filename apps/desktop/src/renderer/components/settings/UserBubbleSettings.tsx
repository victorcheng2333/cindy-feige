import { useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Check } from 'lucide-react';
import {
  USER_BUBBLE_PRESETS,
  parseUserBubblePreference,
  userBubbleSeed,
  type UserBubblePreference,
} from '@cindy/maker-shared';

import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { SettingsField } from '@/components/ui/settings-rows';
import { CHAT_BODY_CLASS } from '@/components/chat/chatChrome';
import { cn } from '@/lib/utils';
import {
  resolveDesktopUserBubbleColors,
  useUserBubbleAppearance,
  userBubbleSurfaceStyle,
} from '@/lib/userBubblePreference';
import { DefaultOverrideControls } from './DefaultOverrideControls';
import { appearanceSettings } from './AppearanceSection.settings-search';

const SATURATION = 0.75;
const VALUE = 0.9;

function hueToHex(h: number): `#${string}` {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return VALUE - VALUE * SATURATION * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return `#${[f(5), f(3), f(1)].map((c) => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
}

const HUE_RAINBOW = `linear-gradient(to right,${[0, 60, 120, 180, 240, 300, 360].map(hueToHex).join(',')})`;

function hexToHue(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  if (d === 0) return 0;
  const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return (h * 60 + 360) % 360;
}

function pickerSeed(preference: UserBubblePreference): string {
  return userBubbleSeed(preference === 'default' ? 'sage' : preference)!;
}

export function UserBubbleSettings() {
  const { t } = useTranslation();
  const { preference, isCustomized, setPreference, colors, dark } = useUserBubbleAppearance();
  const [customOpen, setCustomOpen] = useState(() => preference.startsWith('#'));
  const [draftHex, setDraftHex] = useState(() => pickerSeed(preference));
  const [liveHex, setLiveHex] = useState<string | null>(null);
  const label = (name: string) => t(`settings.appearance.userBubble.${name}`);
  const previewPreference = liveHex ? parseUserBubblePreference(liveHex) : preference;
  const preview = useMemo(
    () =>
      previewPreference === preference
        ? colors
        : resolveDesktopUserBubbleColors(previewPreference, dark),
    [colors, dark, preference, previewPreference],
  );

  const select = (next: UserBubblePreference) => {
    const parsed = parseUserBubblePreference(next);
    setPreference(parsed);
    if (parsed.startsWith('#')) {
      setDraftHex(parsed);
      setCustomOpen(true);
    } else {
      setCustomOpen(false);
      setDraftHex(pickerSeed(parsed));
    }
  };

  return (
    <SettingsField
      id={appearanceSettings.userBubble.targetId}
      title={t(appearanceSettings.userBubble.titleKey)}
      hint={t(appearanceSettings.userBubble.descriptionKey)}
      action={<DefaultOverrideControls isCustomized={isCustomized} onReset={() => select('default')} />}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col items-end gap-2 rounded-xl bg-[var(--surface)] px-3 py-3">
          <div
            data-testid="settings.userBubble.preview"
            className={cn(
              CHAT_BODY_CLASS,
              'max-w-[86%] rounded-xl border-[0.5px] border-[var(--msg-user-border)] bg-[var(--msg-user-bg)] px-4 py-2.5 text-[var(--msg-user-text)]',
            )}
            style={userBubbleSurfaceStyle(preview)}
          >
            {label('sampleUser')}
          </div>
          <p className={cn(CHAT_BODY_CLASS, 'max-w-[86%] self-start text-[var(--msg-assistant-text)]')}>
            {label('sampleAssistant')}
          </p>
        </div>

        <div
          role="radiogroup"
          aria-label={label('presets')}
          className="flex flex-wrap gap-x-1 gap-y-3"
        >
          {USER_BUBBLE_PRESETS.map((id) => {
            const swatch = resolveDesktopUserBubbleColors(id, dark);
            const selected = preference === id;
            return (
              <button
                key={id}
                type="button"
                role="radio"
                aria-checked={selected}
                data-setting-id={appearanceSettings.userBubble.id}
                data-testid={`settings.userBubble.${id}`}
                onClick={() => select(id)}
                className="flex w-16 min-h-9 flex-col items-center gap-1.5 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                <span
                  className={cn(
                    'flex size-8 items-center justify-center rounded-full border-[0.5px]',
                    selected ? 'border-[var(--text-primary)]' : 'border-[var(--border-default)]',
                  )}
                  style={{
                    background: swatch?.background ?? 'var(--surface-elevated)',
                    borderColor: selected ? undefined : swatch?.border,
                  }}
                >
                  {selected ? <Check size={14} aria-hidden className="text-[var(--text-primary)]" /> : null}
                </span>
                <span className="text-11 leading-[1.3] text-[var(--text-secondary)]">{label(id)}</span>
              </button>
            );
          })}
        </div>

        <Button
          variant="secondary"
          size="sm"
          compact
          aria-pressed={customOpen}
          data-setting-id={appearanceSettings.userBubble.id}
          data-testid="settings.userBubble.custom"
          onClick={() => {
            const next = !customOpen;
            setCustomOpen(next);
            if (next) {
              const seed = pickerSeed(preference);
              setDraftHex(seed);
            }
          }}
        >
          {label('custom')}
        </Button>

        {customOpen ? (
          <div className="flex flex-col gap-2">
            <Slider
              min={0}
              max={359}
              step={1}
              value={[hexToHue(draftHex)]}
              aria-label={label('hue')}
              aria-valuetext={draftHex}
              data-setting-id={appearanceSettings.userBubble.id}
              data-testid="settings.userBubble.hue"
              className="[&_.cindy-slider-fill]:bg-transparent"
              style={{ '--slider-track': HUE_RAINBOW, '--slider-fill': 'transparent' } as CSSProperties}
              onValueChange={([hue]) => {
                const next = hueToHex(hue ?? 0);
                setDraftHex(next);
                setLiveHex(next);
              }}
              onValueCommit={([hue]) => {
                const next = hueToHex(hue ?? 0);
                setLiveHex(null);
                select(parseUserBubblePreference(next));
              }}
            />
            <p className="text-12 leading-[1.4] text-[var(--text-secondary)]">{label('customHint')}</p>
          </div>
        ) : null}
      </div>
    </SettingsField>
  );
}
