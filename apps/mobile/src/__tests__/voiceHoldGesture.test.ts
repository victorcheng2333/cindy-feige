import { describe, expect, it } from 'vitest';
import { resolveVoiceHoldZoneForEvent } from '@/session/voiceHoldGesture';

// 按住说话松手判定(2026-11-14 用户要求对齐微信):浮层与松手共用这份几何,
// 判错区域会直接把用户想取消的录音发出去。tier: unit。
// 场景:390×844 窗口,收起态输入框在底部中间 (195, 780) 被长按。
const window = { width: 390, height: 844 };
const start = { startPageX: 195, startPageY: 780 };
const zoneAt = (pageX: number, pageY: number, frame: { x: number; y: number; width: number; height: number } | null = null) =>
  resolveVoiceHoldZoneForEvent({ frame, window, ...start, pageX, pageY });

describe('voice hold release zone', () => {
  it('sends when the finger stays near where it pressed', () => {
    expect(zoneAt(195, 780)).toBe('send');
    expect(zoneAt(185, 740)).toBe('send');
    expect(zoneAt(240, 780)).toBe('send');
    expect(zoneAt(150, 780)).toBe('send');
  });

  it('cancels on a left slide and edits on a right slide, without lifting to the buttons', () => {
    expect(zoneAt(195 - 100, 780)).toBe('cancel');
    expect(zoneAt(195 + 100, 780)).toBe('edit');
  });

  it('cancels / edits when the finger reaches the left / right zone above', () => {
    expect(zoneAt(90, 640)).toBe('cancel');
    expect(zoneAt(300, 640)).toBe('edit');
  });

  it('keeps the center gap as send so the result does not flicker', () => {
    expect(zoneAt(195, 640)).toBe('send');
  });

  it('measures zones relative to the overlay frame when it is offset in the window', () => {
    // 分屏 / 侧栏布局:浮层从窗口 x=300 开始,宽 390。左右分界在窗口 x=495。
    const frame = { x: 300, y: 0, width: 390, height: 844 };
    const at = (pageX: number, pageY: number) =>
      resolveVoiceHoldZoneForEvent({ frame, window, startPageX: 495, startPageY: 780, pageX, pageY });
    expect(at(420, 640)).toBe('cancel');
    expect(at(600, 640)).toBe('edit');
  });
});
