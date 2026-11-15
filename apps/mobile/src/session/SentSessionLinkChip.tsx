import { useMemo } from 'react';
import { CornerDownRight, MessageSquareQuote } from 'lucide-react-native';
import { i18n } from '@/i18n';
import { InlineReferenceChip } from '@/session/InlineReferenceChip';
import { useRemoteSessionMessages, useRemoteSessionTitles } from '@/session/remoteSessionStore';
import { parseSessionDeepLinkUrl } from '@/session/sessionLinks';
import { mobileSessionMessageDisplayText, sentSessionMessageChipLabel } from '@/session/sessionMessageText';
import { iconSize, iconStroke, useTheme } from '@/theme';

/**
 * A task / message reference inside the user's own sent message, drawn as a reference
 * chip like Desktop's SessionLinkChip (2026-11-15): pill, border, icon, underline when it
 * opens. Titles resolve exactly as the markdown session link does.
 */
export function SentSessionLinkChip({
  label: explicit,
  onOpenSessionLink,
  url,
}: {
  label: string | null;
  onOpenSessionLink?: (url: string) => void;
  url: string;
}) {
  const { colors } = useTheme();
  const target = parseSessionDeepLinkUrl(url);
  const sessionId = target?.sessionId ?? '';
  const titles = useRemoteSessionTitles(sessionId ? [sessionId] : []);
  const messages = useRemoteSessionMessages(sessionId);
  const messageClientId = target?.messageClientId;
  const targetMessage = messageClientId
    ? messages.find((message) => message.clientId === messageClientId || message.id === messageClientId)
    : null;
  const messageLabel = useMemo(() => {
    const text = targetMessage ? mobileSessionMessageDisplayText(targetMessage) : null;
    return text ? sentSessionMessageChipLabel(text) : '';
  }, [targetMessage]);
  const label = messageClientId
    ? messageLabel || i18n.t('message.renderer.messageChipFallback')
    : (explicit ?? titles?.[sessionId] ?? i18n.t('message.renderer.sessionChipFallback'));
  const Icon = messageClientId ? MessageSquareQuote : CornerDownRight;
  return (
    <InlineReferenceChip
      accessibilityLabel={label}
      icon={<Icon color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />}
      label={label}
      onPress={onOpenSessionLink ? () => onOpenSessionLink(url) : undefined}
      testID="message.sessionLinkChip"
      underline={Boolean(onOpenSessionLink)}
    />
  );
}
