import { Settings } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { DropdownMenuItem } from '@/components/ui/dropdown-menu';
import { useMacFullscreen } from '@/hooks/useMacFullscreen';
import { checkForUpdateWithToast } from '@/lib/checkForUpdateWithToast';
import { createLogger } from '@/lib/logger';

const log = createLogger('ApplicationMenuItems');

/** Application actions live in the sidebar account menu, leaving the title bar for navigation. */
export function ApplicationMenuItems({ onJoinSharedTask }: { onJoinSharedTask: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { isMac, isFullscreen } = useMacFullscreen();
  const onExitFullscreen =
    isMac && isFullscreen ? () => window.electronAPI?.windowExitFullscreen() : undefined;

  return (
    <>
      <DropdownMenuItem onSelect={onJoinSharedTask}>
        {t('sharedTask.join')}
      </DropdownMenuItem>
      {onExitFullscreen && (
        <DropdownMenuItem onSelect={onExitFullscreen}>
          {t('contentHeader.exitFullscreen')}
        </DropdownMenuItem>
      )}
      <DropdownMenuItem
        className="gap-2.5"
        onSelect={() => {
          log.info('Settings clicked');
          if (`${location.pathname}${location.search}` !== '/settings') {
            navigate('/settings');
          }
        }}
      >
        <Settings className="h-4 w-4" aria-hidden="true" />
        {t('titleBar.menuItems.settings')}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          void window.electronAPI.resourceUsageWindow.open().catch((err: unknown) => {
            log.error('Failed to open resource usage window', err);
          });
        }}
      >
        {t('titleBar.menuItems.resourceUsage')}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          log.info('Help clicked');
          navigate('/settings?tab=help');
        }}
      >
        {t('titleBar.menuItems.help')}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          log.info('Issues clicked');
          navigate('/issues');
        }}
      >
        {t('titleBar.menuItems.issues')}
      </DropdownMenuItem>
      <DropdownMenuItem
        onSelect={() => {
          void checkForUpdateWithToast(t);
        }}
      >
        {t('titleBar.menuItems.checkForUpdates')}
      </DropdownMenuItem>
    </>
  );
}
