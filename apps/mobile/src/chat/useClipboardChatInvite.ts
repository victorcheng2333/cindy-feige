import { useEffect, useRef } from 'react';
import { AppState, Platform } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import { getChatInviteIntent, getChatInviteSequence, parseChatInviteLink, receiveChatInviteLink, subscribeChatInviteIntent } from './chatInviteIntent';

/** Android foreground discovery. iOS invitations require a link or user-initiated paste. */
export function useClipboardChatInvite(enabled: boolean, owner: MobileAuthOwnerGeneration): void {
  const handledLinks = useRef(new Set<string>());
  useEffect(() => {
    // Even checking a new clipboard on launch can ask for paste permission on
    // iOS. An in-process change-count cache cannot prevent this after relaunch.
    if (!enabled || Platform.OS !== 'android') return;
    let disposed = false;
    let busy = false;
    let background = 0;
    let pending: { link: string; sequence: number; background: number } | undefined;
    const remember = () => {
      const invitation = getChatInviteIntent();
      const link = invitation?.link ?? invitation?.manualLink;
      if (link) handledLinks.current.add(link);
    };
    remember();
    const unsubscribe = subscribeChatInviteIntent(remember);
    const current = () => !disposed && isMobileAuthOwnerCurrent(owner);
    const present = () => {
      if (!pending || AppState.currentState !== 'active') return;
      const target = pending;
      pending = undefined;
      if (!current() || target.background !== background || target.sequence !== getChatInviteSequence()
        || getChatInviteIntent()) return;
      if (handledLinks.current.has(target.link)) return;
      handledLinks.current.add(target.link);
      receiveChatInviteLink(target.link);
    };
    const check = async () => {
      if (!current() || busy || AppState.currentState !== 'active' || getChatInviteIntent()) return;
      busy = true;
      const started = background;
      const sequence = getChatInviteSequence();
      try {
        if (!await Clipboard.hasStringAsync()) return;
        if (!current() || started !== background || sequence !== getChatInviteSequence()
          || AppState.currentState !== 'active') return;
        const text = await Clipboard.getStringAsync();
        if (!current()) return;
        if (started !== background) return;
        const link = text.length <= 8192 ? parseChatInviteLink(text.trim()) : null;
        if (link) pending = { link, sequence, background: started };
        present();
      } catch {
        // Permission denial or unavailable clipboard leaves the existing manual entry usable.
      } finally {
        busy = false;
        if (current() && started !== background && AppState.currentState === 'active') void check();
      }
    };
    const subscription = AppState.addEventListener('change', state => {
      if (state === 'background') { background++; pending = undefined; }
      if (state === 'active') { present(); void check(); }
    });
    void check();
    return () => { disposed = true; pending = undefined; subscription.remove(); unsubscribe(); };
  }, [enabled, owner]);
}
