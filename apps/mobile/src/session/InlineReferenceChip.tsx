import type { ReactNode } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Text } from '@/components/AppText';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { fontWeight, lineHeight, radius, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';
import { useUserBubbleChipColors } from '@/theme/userBubblePreference';

/** Shared compact pill shell for composer-adjacent and sent-message references. */
export function InlineReferenceChip({
  accessibilityLabel,
  icon,
  label,
  onPress,
  testID,
  underline = false,
}: {
  accessibilityLabel?: string;
  icon?: ReactNode;
  label: string;
  onPress?: () => void;
  testID?: string;
  /** Underline the label: the chat's only "this opens something" signal (DESIGN.md §14.5). */
  underline?: boolean;
}) {
  const styles = useThemedStyles(makeStyles);
  // Inside the user's own tinted bubble: a deeper step of the bubble hue, not the
  // theme's opaque neutral chip (2026-11-15). Elsewhere the theme chip stays.
  const tint = useUserBubbleChipColors();
  const tintStyle = tint ? { backgroundColor: tint.background, borderColor: tint.border } : null;
  const content = (
    <>
      {icon ? <View style={styles.icon}>{icon}</View> : null}
      <Text numberOfLines={1} style={[styles.label, underline && styles.underline]}>{label}</Text>
    </>
  );
  if (!onPress) return <View style={[styles.pill, tintStyle]} testID={testID}>{content}</View>;
  return (
    <Pressable
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityRole="button"
      hitSlop={8}
      onPress={onPress}
      style={({ pressed }) => [styles.pill, tintStyle, pressed && styles.pressed]}
      testID={testID}
    >
      {content}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  pill: {
    alignItems: 'center',
    alignSelf: 'flex-start',
    backgroundColor: colors.surfaceChip,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: 6,
    maxWidth: 240,
    paddingHorizontal: spacing.sm,
    paddingVertical: 2,
  },
  icon: { alignItems: 'center', justifyContent: 'center' },
  label: {
    color: colors.textPrimary,
    flexShrink: 1,
    fontSize: typeScale.bodySmall,
    fontWeight: fontWeight.regular,
    lineHeight: lineHeight.bodySmall,
  },
  pressed: mobileInteractionStyles.pressed,
  underline: { textDecorationLine: 'underline' },
});
