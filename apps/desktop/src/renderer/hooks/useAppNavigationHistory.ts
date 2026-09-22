import { useState } from 'react';
import { useLocation, useNavigate, useNavigationType } from 'react-router-dom';

interface NavigationHistory {
  keys: string[];
  index: number;
}

/**
 * Track only entries visited by this mounted, owner-scoped MainLayout. Keeping
 * this above ChromeActions preserves history while Settings hides the buttons;
 * signing out or switching accounts starts a fresh boundary. Router deltas retain
 * each entry's search, hash and state without replaying page-opening side effects.
 */
export function useAppNavigationHistory() {
  const { key } = useLocation();
  const action = useNavigationType();
  const navigate = useNavigate();
  const [history, setHistory] = useState<NavigationHistory>(() => ({ keys: [key], index: 0 }));

  if (history.keys[history.index] !== key) {
    if (action === 'PUSH') {
      const keys = [...history.keys.slice(0, history.index + 1), key];
      setHistory({ keys, index: keys.length - 1 });
    } else if (action === 'REPLACE') {
      const keys = [...history.keys];
      keys[history.index] = key;
      setHistory({ keys, index: history.index });
    } else {
      const index = history.keys.indexOf(key);
      // An external POP outside this layout's known history cannot authorize
      // navigation into an earlier login/account's entries.
      setHistory(index < 0 ? { keys: [key], index: 0 } : { ...history, index });
    }
  }

  const canGoBack = history.index > 0;
  const canGoForward = history.index < history.keys.length - 1;
  return {
    canGoBack,
    canGoForward,
    goBack: () => {
      if (canGoBack) void navigate(-1);
    },
    goForward: () => {
      if (canGoForward) void navigate(1);
    },
  };
}

export type AppNavigationHistory = ReturnType<typeof useAppNavigationHistory>;
