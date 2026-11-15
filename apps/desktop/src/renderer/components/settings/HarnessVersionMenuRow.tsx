import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { useHarnessPreference } from '@/hooks/useHarnessPreference';
import { toast } from '@/lib/toast';

/** Shared About geometry so every harness row and menu stays identical to Pi's. */
export const HARNESS_MENU_ITEM_CLASS = 'gap-3';

/** One harness, one row: the version pill opens that harness's action menu. */
export function HarnessVersionMenuRow({ harnessKind, label, manageLabel, version, status, pending, testId, children }: {
  /** Harness id(claude-code / codex / pi / cursor):菜单顶部带「在模型选择器中显示」开关。 */
  harnessKind: string;
  label: string;
  manageLabel: string;
  /** 尚无可显示版本的 Harness 可以不传。 */
  version?: string;
  status: string;
  /** Shows the spinner before the status while a check or install is running. */
  pending: boolean;
  testId?: string;
  /** 版本与更新操作;没有时菜单只有显示开关。 */
  children?: ReactNode;
}) {
  const { t } = useTranslation();
  const preference = useHarnessPreference(harnessKind);
  const hidden = preference.loaded && !preference.enabled;
  const toggle = (enabled: boolean) => {
    preference.setEnabled(enabled).catch(() => toast.error(t('settings.about.harnessToggleFailed')));
  };
  return (
    <div className="flex min-h-[52px] min-w-0 items-center justify-between gap-3 overflow-hidden px-4 py-2" data-testid={testId}>
      <span className="flex shrink-0 flex-col">
        <span className="text-13 font-medium text-[var(--settings-section-sublabel)]">{label}</span>
        {hidden && (
          <span className="text-12 leading-[1.35] text-[var(--text-secondary)]">{t('settings.about.harnessHiddenStatus')}</span>
        )}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label={manageLabel} className="-mr-2 flex min-h-9 min-w-0 flex-1 items-center justify-end gap-2 rounded-full px-2 text-13 font-medium text-[var(--settings-section-title)] hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring-soft)]">
            {version && <span className="shrink-0 truncate">{version}</span>}
            {status && (
              <span role="status" className="flex min-w-0 items-center gap-1 text-12 font-normal leading-[1.35] text-[var(--settings-section-sublabel)]">
                {pending && <Spinner size={12} />}
                <span className="min-w-0 text-left break-words">{status}</span>
              </span>
            )}
            <ChevronDown size={13} aria-hidden className="shrink-0" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" sideOffset={6} className="z-[10000] w-[272px] max-w-[calc(100vw-24px)] p-1.5">
          <DropdownMenuCheckboxItem
            checked={preference.enabled}
            disabled={!preference.loaded || preference.isLastEnabled}
            onCheckedChange={(checked) => toggle(checked === true)}
          >
            {t('settings.about.harnessShowInPicker')}
          </DropdownMenuCheckboxItem>
          <HarnessMenuFootnote>
            {preference.isLastEnabled ? t('settings.about.harnessLastEnabledHint') : t('settings.about.harnessToggleHint')}
          </HarnessMenuFootnote>
          {children && <DropdownMenuSeparator />}
          {children}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/** Menu action with its target version right-aligned; "—" until a version is known. */
export function HarnessVersionMenuItem({ label, version, disabled, onSelect }: {
  label: string;
  version: string | null | undefined;
  disabled: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem className={HARNESS_MENU_ITEM_CLASS} disabled={disabled} onSelect={onSelect}>
      <span className="flex-1">{label}</span><span className="text-12 leading-[1.33] text-[var(--cmd-palette-item-meta)]">{version ?? '—'}</span>
    </DropdownMenuItem>
  );
}

export function HarnessMenuFootnote({ children }: { children: ReactNode }) {
  return <p className="px-2 py-1.5 text-11 text-[var(--text-secondary)]">{children}</p>;
}
