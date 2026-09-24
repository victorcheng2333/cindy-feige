// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/', search: '' }),
  useNavigate: () => vi.fn(),
}));

vi.mock('@/lib/checkForUpdateWithToast', () => ({
  checkForUpdateWithToast: vi.fn(),
}));

import { ApplicationMenuItems } from '@/components/sidebar/ApplicationMenuItems';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('Application actions in the account menu', () => {
  it('exposes all former title-bar actions from the account dropdown', async () => {
    const user = userEvent.setup();
    const joinSharedTask = vi.fn();
    render(
      <DropdownMenu>
        <DropdownMenuTrigger>Account</DropdownMenuTrigger>
        <DropdownMenuContent>
          <ApplicationMenuItems onJoinSharedTask={joinSharedTask} />
        </DropdownMenuContent>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'Account' }));
    for (const item of ['settings', 'resourceUsage', 'help', 'issues', 'checkForUpdates']) {
      expect(screen.getByRole('menuitem', { name: `titleBar.menuItems.${item}` })).toBeTruthy();
    }
    await user.click(screen.getByRole('menuitem', { name: 'sharedTask.join' }));
    expect(joinSharedTask).toHaveBeenCalledOnce();
  });
});
