/**
 * 按住说话的手势分区(2026-11-14 用户要求对齐微信的语音按住交互):
 * 没聚焦的输入框上长按进入按住态,浮层上方实时显示识别文字;往左滑(或移到左侧
 * 「取消」)松手放弃本次录音,往右滑(或移到右侧「编辑」)松手把文字留在输入框里
 * 继续改,停在原处松手直接发送。
 *
 * 浮层与松手判定共用这里的几何,画出来的区域就是能命中的区域。坐标一律是窗口坐标
 * (手势事件的 pageX / pageY),浮层的窗口位置由宿主量好后传入。
 */

export type VoiceHoldZone = 'send' | 'cancel' | 'edit';

export interface VoiceHoldFrame {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface VoiceHoldLayout {
  /** 浮层自身在窗口里的位置与尺寸。 */
  frame: VoiceHoldFrame;
  /** 「取消 / 编辑」两块区域所在行,浮层内坐标。 */
  zoneTop: number;
  zoneBottom: number;
  /** 左右两块区域的分界(浮层内 x)。 */
  centerX: number;
}

/**
 * 长按成立所需时间,与桌面端长按输入框唤醒语音一致(ChatInput 的 VOICE_INPUT_LONG_PRESS_MS,
 * 2026-11-14 用户确认这个时长刚好)。也晚于输入框自身「长按之后的拖动归编辑器」的 350ms 分界
 * (composerResize 的 COMPOSER_BODY_DRAG_LONG_PRESS_MS),长按成立时竖向拖拽手势已经放手。
 */
export const VOICE_HOLD_DELAY_MS = 450;

/**
 * 按压保持范围:按住态里手指会滑到屏幕别处的区域,不能因为离开输入框
 * 就被当作松手(Pressable 离开保持范围会立即触发 onPressOut)。
 */
export const VOICE_HOLD_PRESS_RETENTION = { top: 10000, bottom: 10000, left: 10000, right: 10000 } as const;

/** 两块区域的高度。 */
export const VOICE_HOLD_ZONE_HEIGHT = 72;
/** 区域行底边比按下点高出的距离:手指往上抬一小段就能够到。 */
export const VOICE_HOLD_ZONE_LIFT = 96;
/** 区域行最高不超过这里,给上方的文字气泡留出位置。 */
export const VOICE_HOLD_ZONE_MIN_TOP = 160;
/** 两块区域中间的空档,手指在正中时仍按发送处理,不来回跳。 */
export const VOICE_HOLD_CENTER_GAP = 24;
/** 从按下点横向滑过这段距离:往左算取消、往右算编辑,不必抬到上方的按钮上。 */
export const VOICE_HOLD_SLIDE = 96;

/** 浮层还没量到窗口位置时的估算:按铺满窗口处理。 */
export function resolveVoiceHoldFallbackFrame(window: { width: number; height: number }): VoiceHoldFrame {
  return { x: 0, y: 0, width: window.width, height: window.height };
}

/** 松手判定:浮层量到的位置优先,没量到时与浮层用同一份估算。 */
export function resolveVoiceHoldZoneForEvent(input: {
  frame: VoiceHoldFrame | null;
  window: { width: number; height: number };
  startPageX: number;
  startPageY: number;
  pageX: number;
  pageY: number;
}): VoiceHoldZone {
  const frame = input.frame ?? resolveVoiceHoldFallbackFrame(input.window);
  return resolveVoiceHoldZone({
    layout: computeVoiceHoldLayout({ frame, startPageY: input.startPageY }),
    startPageX: input.startPageX,
    pageX: input.pageX,
    pageY: input.pageY,
  });
}

export function computeVoiceHoldLayout(input: {
  frame: VoiceHoldFrame;
  /** 按下点的窗口纵坐标。 */
  startPageY: number;
}): VoiceHoldLayout {
  const { frame } = input;
  const localStartY = input.startPageY - frame.y;
  const maxTop = Math.max(0, frame.height - VOICE_HOLD_ZONE_HEIGHT);
  const minTop = Math.min(VOICE_HOLD_ZONE_MIN_TOP, maxTop);
  const zoneTop = Math.min(maxTop, Math.max(minTop, localStartY - VOICE_HOLD_ZONE_LIFT - VOICE_HOLD_ZONE_HEIGHT));
  return {
    frame,
    zoneTop,
    zoneBottom: zoneTop + VOICE_HOLD_ZONE_HEIGHT,
    centerX: frame.width / 2,
  };
}

export function resolveVoiceHoldZone(input: {
  layout: VoiceHoldLayout;
  startPageX: number;
  pageX: number;
  pageY: number;
}): VoiceHoldZone {
  const { layout } = input;
  const x = input.pageX - layout.frame.x;
  const y = input.pageY - layout.frame.y;
  const halfGap = VOICE_HOLD_CENTER_GAP / 2;
  if (y <= layout.zoneBottom) {
    if (x < layout.centerX - halfGap) return 'cancel';
    if (x > layout.centerX + halfGap) return 'edit';
  }
  const slide = input.pageX - input.startPageX;
  if (slide <= -VOICE_HOLD_SLIDE) return 'cancel';
  if (slide >= VOICE_HOLD_SLIDE) return 'edit';
  return 'send';
}
