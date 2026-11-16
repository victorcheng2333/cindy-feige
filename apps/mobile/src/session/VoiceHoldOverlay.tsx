import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type MutableRefObject } from 'react';
import { Animated, Easing, ScrollView, StyleSheet, View, useWindowDimensions, type ScrollViewInstance, type ViewInstance } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { Mic, PencilLine, X } from 'lucide-react-native';
import { Text } from '@/components/AppText';
import { useReduceMotionEnabled } from '@/hooks/useReduceMotion';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { iconSize, iconStroke, lineHeight, motionDuration, radius, spacing, typeScale } from '@/theme/tokens';
import { BlurBackdrop } from '@/session/BlurBackdrop';
import { VoiceMicWaveCaret } from '@/session/MobileComposerInputRow';
import { formatVoiceRecordingTime } from '@/session/VoiceRecordingPill';
import {
  computeVoiceHoldLayout,
  resolveVoiceHoldFallbackFrame,
  VOICE_HOLD_ZONE_HEIGHT,
  type VoiceHoldFrame,
  type VoiceHoldZone,
} from '@/session/voiceHoldGesture';

export interface VoiceHoldState {
  startPageX: number;
  startPageY: number;
  zone: VoiceHoldZone;
}

interface VoiceHoldTextSource {
  subscribe(listener: () => void): () => void;
  getSnapshot(): { draft: string };
}

interface VoiceHoldOverlayProps {
  /** 非 null 时显示按住态浮层。 */
  hold: VoiceHoldState | null;
  /** 浮层把自己在窗口里的位置写到这里,宿主松手判定用同一份几何。 */
  frameRef: MutableRefObject<VoiceHoldFrame | null>;
  /** 识别文字:直接给字符串,或给草稿源(会话页草稿走外部 store,避免整页逐字重渲)。 */
  text?: string;
  textSource?: VoiceHoldTextSource;
  testID?: string;
}

/** 左右两个圆形操作钮的直径。 */
const ACTION_SIZE = 72;
/** 手指移到操作钮所在一侧时的放大倍数。 */
const ACTION_ACTIVE_SCALE = 1.18;
/** 底部弧形托盘:取一个比屏幕宽得多的圆,只露出顶部一段弧。 */
const BASE_ARC_WIDTH_RATIO = 2.4;
/** 气泡与「取消 / 编辑」之间的留白。 */
const BUBBLE_GAP = spacing.xl;
/** 操作钮下方文字标签占的高度(间距 + 一行 caption + 上下内边距)。 */
const ACTION_LABEL_SPACE = spacing.sm + lineHeight.caption + spacing.xs;

/**
 * 按住说话浮层:铺满宿主根视图,不接收触摸(手势始终归输入框),只负责展示——
 * 上方气泡实时显示将要发送的文字,左右两个圆钮提示「取消 / 编辑」,底部托盘提示当前
 * 松手会发生什么。浮层常驻挂载以便提前量好窗口位置,按住时才渲染内容。
 */
export function VoiceHoldOverlay({ hold, frameRef, text, textSource, testID }: VoiceHoldOverlayProps) {
  const viewRef = useRef<ViewInstance>(null);
  const measure = useCallback(() => {
    viewRef.current?.measureInWindow((x, y, width, height) => {
      if (width > 0 && height > 0) frameRef.current = { x, y, width, height };
    });
  }, [frameRef]);
  const holding = hold !== null;
  useEffect(() => {
    // 键盘、分屏变化后根视图可能挪了位置:每次进入按住态重新量一次。
    if (holding) measure();
  }, [holding, measure]);
  return (
    <View
      ref={viewRef}
      collapsable={false}
      onLayout={measure}
      pointerEvents="none"
      style={overlayStyles.root}
      testID={testID}
    >
      {hold ? (
        <VoiceHoldContent hold={hold} frame={frameRef.current} text={text} textSource={textSource} />
      ) : null}
    </View>
  );
}

const overlayStyles = StyleSheet.create({
  root: {
    ...StyleSheet.absoluteFill,
    elevation: 1000,
    zIndex: 1000,
  },
});

/** 进入动画:遮罩淡入,内容从下方轻推上来。减弱动态效果时直接到位。 */
function useEntrance(reduceMotion: boolean | null) {
  const progress = useRef(new Animated.Value(0)).current;
  useEffect(() => {
    if (reduceMotion !== false) {
      progress.setValue(1);
      return;
    }
    const animation = Animated.timing(progress, {
      duration: motionDuration.enter,
      easing: Easing.bezier(0.16, 1, 0.3, 1),
      toValue: 1,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [progress, reduceMotion]);
  return progress;
}

/** 操作钮跟随手指放大:0 = 静止,1 = 手指在这一侧。 */
function useActiveScale(active: boolean, reduceMotion: boolean | null) {
  const value = useRef(new Animated.Value(active ? 1 : 0)).current;
  useEffect(() => {
    if (reduceMotion !== false) {
      value.setValue(active ? 1 : 0);
      return;
    }
    const animation = Animated.timing(value, {
      duration: motionDuration.fast,
      easing: Easing.bezier(0.4, 0, 0.2, 1),
      toValue: active ? 1 : 0,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [active, reduceMotion, value]);
  return value;
}

/** 本次按住的录音时长(从浮层出现起算),只做展示。 */
function useHoldSeconds() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSeconds((current) => current + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  return seconds;
}

function VoiceHoldContent({ hold, frame, text, textSource }: {
  hold: VoiceHoldState;
  frame: VoiceHoldFrame | null;
  text?: string;
  textSource?: VoiceHoldTextSource;
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReduceMotionEnabled();
  const entrance = useEntrance(reduceMotion);
  const window = useWindowDimensions();
  const seconds = useHoldSeconds();
  // 浮层挂载时即量位置,正常按下前早已量好;万一还没量到,按铺满窗口估算。
  const resolvedFrame = frame ?? resolveVoiceHoldFallbackFrame(window);
  const layout = computeVoiceHoldLayout({ frame: resolvedFrame, startPageY: hold.startPageY });
  const { zone } = hold;
  const width = resolvedFrame.width;
  const topInset = Math.max(0, insets.top - resolvedFrame.y) + spacing.lg;
  const actionTop = layout.zoneTop + (VOICE_HOLD_ZONE_HEIGHT - ACTION_SIZE) / 2;
  const arcWidth = width * BASE_ARC_WIDTH_RATIO;
  // 托盘让到「取消 / 编辑」的文字标签下方,不压住标签。
  const arcTop = actionTop + ACTION_SIZE + ACTION_LABEL_SPACE + spacing.md;
  const hint = zone === 'cancel'
    ? t('session.common.voiceHoldReleaseToCancel')
    : zone === 'edit'
      ? t('session.common.voiceHoldReleaseToEdit')
      : t('session.common.voiceHoldReleaseToSend');
  const rise = entrance.interpolate({ inputRange: [0, 1], outputRange: [spacing.lg, 0] });

  return (
    <Animated.View style={[StyleSheet.absoluteFill, { opacity: entrance }]}>
      <BlurBackdrop intensity={40} />
      <Animated.View style={[StyleSheet.absoluteFill, { transform: [{ translateY: rise }] }]}>
        <View
          style={[
            styles.bubbleArea,
            { top: topInset, height: Math.max(0, actionTop - BUBBLE_GAP - topInset) },
          ]}
        >
          <VoiceHoldBubble cancel={zone === 'cancel'} seconds={seconds} text={text} textSource={textSource} />
        </View>
        <VoiceHoldAction
          active={zone === 'cancel'}
          kind="cancel"
          label={t('session.common.voiceHoldCancel')}
          left={width / 4 - ACTION_SIZE / 2}
          reduceMotion={reduceMotion}
          top={actionTop}
        />
        <VoiceHoldAction
          active={zone === 'edit'}
          kind="edit"
          label={t('session.common.voiceHoldEdit')}
          left={(width * 3) / 4 - ACTION_SIZE / 2}
          reduceMotion={reduceMotion}
          top={actionTop}
        />
        <View
          style={[
            styles.baseArc,
            zone === 'send' && styles.baseArcActive,
            {
              borderRadius: arcWidth / 2,
              height: arcWidth,
              left: (width - arcWidth) / 2,
              top: arcTop,
              width: arcWidth,
            },
          ]}
        >
          <View style={[styles.baseContent, { width }]}>
            <Text
              style={[
                styles.hintText,
                zone === 'cancel' && styles.hintTextCancel,
              ]}
              testID="voiceHold.hint"
            >
              {hint}
            </Text>
            <View style={[styles.micBadge, zone === 'send' && styles.micBadgeActive]}>
              <Mic
                color={zone === 'send' ? colors.ctaText : colors.textSecondary}
                size={iconSize.xl}
                strokeWidth={iconStroke.regular}
              />
            </View>
          </View>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

function VoiceHoldAction({ active, kind, label, left, top, reduceMotion }: {
  active: boolean;
  kind: 'cancel' | 'edit';
  label: string;
  left: number;
  top: number;
  reduceMotion: boolean | null;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const progress = useActiveScale(active, reduceMotion);
  const scale = progress.interpolate({ inputRange: [0, 1], outputRange: [1, ACTION_ACTIVE_SCALE] });
  const Icon = kind === 'cancel' ? X : PencilLine;
  const iconColor = active
    ? kind === 'cancel' ? colors.sharedTaskConfirmForeground : colors.ctaText
    : colors.textSecondary;
  return (
    <View style={[styles.actionColumn, { left: left - spacing.lg, top, width: ACTION_SIZE + spacing.lg * 2 }]}>
      <Animated.View
        accessibilityLabel={label}
        style={[
          styles.actionCircle,
          active && (kind === 'cancel' ? styles.actionCancelActive : styles.actionEditActive),
          { transform: [{ scale }] },
        ]}
        testID={`voiceHold.${kind}Zone`}
      >
        <Icon color={iconColor} size={iconSize.xxl} strokeWidth={iconStroke.regular} />
      </Animated.View>
      <View style={[styles.actionLabelChip, active && styles.actionLabelChipActive]}>
        <Text style={[styles.actionLabel, active && styles.actionLabelActive]}>{label}</Text>
      </View>
    </View>
  );
}

function VoiceHoldBubble({ cancel, seconds, text, textSource }: {
  cancel: boolean;
  seconds: number;
  text?: string;
  textSource?: VoiceHoldTextSource;
}) {
  return textSource
    ? <VoiceHoldSourceBubble cancel={cancel} seconds={seconds} source={textSource} />
    : <VoiceHoldBubbleBody cancel={cancel} seconds={seconds} text={text ?? ''} />;
}

function VoiceHoldSourceBubble({ cancel, seconds, source }: { cancel: boolean; seconds: number; source: VoiceHoldTextSource }) {
  const text = useSyncExternalStore(source.subscribe, () => source.getSnapshot().draft);
  return <VoiceHoldBubbleBody cancel={cancel} seconds={seconds} text={text} />;
}

function VoiceHoldBubbleBody({ cancel, seconds, text }: { cancel: boolean; seconds: number; text: string }) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const scrollRef = useRef<ScrollViewInstance>(null);
  const trimmed = text.trim();
  const primary = cancel ? colors.sharedTaskConfirmForeground : colors.textPrimary;
  const secondary = cancel ? colors.sharedTaskConfirmForeground : colors.textTertiary;
  return (
    <View style={[styles.bubble, cancel && styles.bubbleCancel]} testID="voiceHold.bubble">
      <ScrollView
        ref={scrollRef}
        onContentSizeChange={() => scrollRef.current?.scrollToEnd({ animated: false })}
        scrollEnabled={false}
        showsVerticalScrollIndicator={false}
        style={styles.bubbleScroll}
      >
        {trimmed ? (
          <Text style={[styles.bubbleText, { color: primary }]} testID="voiceHold.text">{trimmed}</Text>
        ) : (
          <Text style={[styles.bubblePlaceholder, { color: secondary }]}>{t('session.common.voiceHoldListening')}</Text>
        )}
      </ScrollView>
      <View style={styles.bubbleFooter}>
        <VoiceMicWaveCaret color={secondary} />
        <Text style={[styles.bubbleTime, { color: secondary }]}>{formatVoiceRecordingTime(seconds)}</Text>
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) => ({
  bubbleArea: {
    justifyContent: 'flex-end' as const,
    left: spacing.lg,
    position: 'absolute' as const,
    right: spacing.lg,
  },
  bubble: {
    alignSelf: 'stretch' as const,
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexShrink: 1,
    gap: spacing.md,
    paddingBottom: spacing.md,
    paddingHorizontal: spacing.xl,
    paddingTop: spacing.xl,
  },
  bubbleCancel: {
    backgroundColor: colors.sharedTaskConfirmBackground,
    borderColor: colors.sharedTaskConfirmBackground,
  },
  bubbleScroll: {
    flexGrow: 0,
    flexShrink: 1,
  },
  bubbleText: {
    color: colors.textPrimary,
    fontSize: typeScale.title,
    lineHeight: lineHeight.headline,
  },
  bubblePlaceholder: {
    color: colors.textTertiary,
    fontSize: typeScale.title,
    lineHeight: lineHeight.headline,
  },
  bubbleFooter: {
    alignItems: 'center' as const,
    flexDirection: 'row' as const,
    justifyContent: 'space-between' as const,
  },
  bubbleTime: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    fontVariant: ['tabular-nums' as const],
    lineHeight: lineHeight.caption,
  },
  actionColumn: {
    alignItems: 'center' as const,
    gap: spacing.sm,
    position: 'absolute' as const,
  },
  actionCircle: {
    alignItems: 'center' as const,
    backgroundColor: colors.surfaceElevated,
    borderColor: colors.border,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    height: ACTION_SIZE,
    justifyContent: 'center' as const,
    width: ACTION_SIZE,
  },
  actionCancelActive: {
    backgroundColor: colors.sharedTaskConfirmBackground,
    borderColor: colors.sharedTaskConfirmBackground,
  },
  actionEditActive: {
    backgroundColor: colors.cta,
    borderColor: colors.cta,
  },
  actionLabelChip: {
    backgroundColor: colors.surfaceElevated,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.md,
    paddingVertical: 2,
  },
  actionLabelChipActive: {
    backgroundColor: colors.cta,
  },
  actionLabel: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
  },
  actionLabelActive: {
    color: colors.ctaText,
  },
  baseArc: {
    alignItems: 'center' as const,
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderWidth: StyleSheet.hairlineWidth,
    position: 'absolute' as const,
  },
  baseArcActive: {
    backgroundColor: colors.surfaceElevated,
  },
  baseContent: {
    alignItems: 'center' as const,
    gap: spacing.md,
    paddingTop: spacing.lg,
  },
  hintText: {
    color: colors.textSecondary,
    fontSize: typeScale.footnote,
    lineHeight: lineHeight.caption,
  },
  hintTextCancel: {
    color: colors.textPrimary,
  },
  micBadge: {
    alignItems: 'center' as const,
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    height: 52,
    justifyContent: 'center' as const,
    width: 52,
  },
  micBadgeActive: {
    backgroundColor: colors.cta,
  },
});
