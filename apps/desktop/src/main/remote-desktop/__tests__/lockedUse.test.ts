/**
 * 测试价值
 * - 生产入口与可观察结果：LockedUseController.prepare / tick / touched / unlocked；观察是否先盖
 *   隐私屏再解锁、何时重新锁屏、暂停与恢复、告诉 Agent 的拒绝原因。
 * - 规则依据：docs/product-rules/locked-use.md（2026-11-16 主人裁决）「流程」「谁能触发解锁」
 *   「保存密码」：遮罩没盖好不解锁；有人碰电脑就锁屏并暂停到主人手动解锁；密码失效不往锁屏填。
 * - 现有覆盖缺口：新模块；awayGuard.test.ts 只覆盖遮罩本身，不覆盖解锁与重新锁屏的时序。
 * - 最小失败输入：遮罩建立失败；盖遮罩时或解锁进行中有人碰电脑（不解锁 / 解锁完成后立刻再锁）；
 *   解锁后任务一直在用电脑（不能按 2 分钟空闲锁回）；撤遮罩时没真锁屏（2026-11-16 实测：任务结束后
 *   桌面被打开）；本机解锁的
 *   系统事件晚到（不能当成主人手动解锁而解除暂停）；任务停止运行；保存的密码被系统拒绝。
 * - tier：unit，内存 fake，无 Electron / 原生进程。
 */
import { describe, expect, it } from 'vitest';
import { LOCKED_USE_IDLE_MS, LockedUseController, type LockedUseDeps } from '../lockedUse';

function setup(overrides: Partial<LockedUseDeps> = {}) {
  const state = {
    now: 0,
    locked: true,
    covered: false,
    allowed: true,
    running: true,
    coverFails: false,
    unlockError: null as string | null,
    /** Runs inside the native unlock, before it returns. */
    duringUnlock: null as (() => void) | null,
    events: [] as string[],
  };
  const deps: LockedUseDeps = {
    ready: async () => 'ready',
    screenLocked: () => state.locked,
    allowed: async () => state.allowed,
    running: () => state.running,
    cover: async () => {
      if (state.coverFails) throw new Error('DESKTOP_PRIVACY_UNAVAILABLE');
      state.covered = true;
      state.events.push('cover');
    },
    covered: () => state.covered,
    uncover: async (reason) => {
      state.events.push(`uncover:${reason}`);
      if (state.covered && !state.locked) state.locked = true; // The cover ends in the real lock.
      state.covered = false;
    },
    unlock: async () => {
      state.events.push('unlock');
      state.duringUnlock?.();
      if (state.unlockError) throw new Error(state.unlockError);
      state.locked = false;
    },
    cancelUnlock: () => state.events.push('cancel'),
    lock: async () => {
      state.events.push('lock');
      state.locked = true;
    },
    now: () => state.now,
    log: () => {},
    ...overrides,
  };
  return { state, controller: new LockedUseController(deps) };
}

describe('LockedUseController', () => {
  it('covers before unlocking and locks again once the task stops or goes quiet', async () => {
    const { state, controller } = setup();
    await expect(controller.prepare('task-1')).resolves.toBe('unlocked');
    expect(state.events).toEqual(['cover', 'unlock']);
    controller.unlocked(); // The system's event for Cindy's own unlock.
    await controller.tick();
    expect(state.locked).toBe(false);
    state.running = false;
    await controller.tick();
    expect(state.events.at(-1)).toBe('uncover:finished');
    expect(state.locked).toBe(true);

    // A task that keeps using the computer keeps the Mac; once it goes quiet, the Mac is locked.
    state.running = true;
    state.now += 60_000;
    await expect(controller.prepare('task-1')).resolves.toBe('unlocked');
    state.now += LOCKED_USE_IDLE_MS - 1;
    await expect(controller.prepare('task-1')).resolves.toBe('not_locked');
    state.now += LOCKED_USE_IDLE_MS - 1;
    await controller.tick();
    expect(state.locked).toBe(false);
    state.now += 1;
    await controller.tick();
    expect(state.locked).toBe(true);
  });

  it('never unlocks without the cover, nor for a task the host does not allow', async () => {
    const { state, controller } = setup();
    state.allowed = false;
    await expect(controller.prepare('guest-task')).resolves.toBe('not_allowed');
    state.allowed = true;
    state.coverFails = true;
    await expect(controller.prepare('task-1')).resolves.toBe('unavailable');
    expect(state.events).not.toContain('unlock');
    expect(state.locked).toBe(true);
    expect(controller.refusal()).toBe('unavailable');
  });

  it('locks again and pauses when someone touches the Mac during the unlock, until the owner unlocks', async () => {
    const { state, controller } = setup();
    state.duringUnlock = () => {
      state.covered = false; // The helper locked on the touch and the cover ended.
      controller.touched();
    };
    await expect(controller.prepare('task-1')).resolves.toBe('paused');
    expect(state.events).toEqual(['cover', 'unlock', 'cancel', 'lock', 'uncover:unlock no longer wanted']);
    expect(state.locked).toBe(true);

    // The late system event of that unlock is not the owner unlocking by hand.
    controller.unlocked();
    state.duringUnlock = null;
    await expect(controller.prepare('task-1')).resolves.toBe('paused');

    state.now += 10_000;
    controller.unlocked(); // The owner unlocked.
    state.locked = true; // ...and the Mac locked again later.
    await expect(controller.prepare('task-1')).resolves.toBe('unlocked');
  });

  it('does not unlock when someone touches the lock screen while the cover goes up', async () => {
    const { state, controller } = setup({
      cover: async () => {
        state.events.push('cover');
        controller.touched(); // The helper locked (already locked) and the cover ended.
      },
    });
    await expect(controller.prepare('task-1')).resolves.toBe('paused');
    expect(state.events).not.toContain('unlock');
    expect(state.locked).toBe(true);
  });

  it('locks the Mac itself when ending the cover left it unlocked', async () => {
    const { state, controller } = setup({
      uncover: async (reason) => {
        state.events.push(`uncover:${reason}`);
        state.covered = false; // Removed without locking, as the 2026-11-16 build did.
      },
    });
    await controller.prepare('task-1');
    state.running = false;
    await controller.tick();
    expect(state.events.slice(-2)).toEqual(['uncover:finished', 'lock']);
    expect(state.locked).toBe(true);
  });

  it('asks for setup again when the saved password is rejected, without retrying it', async () => {
    const { state, controller } = setup();
    state.unlockError = 'CREDENTIAL_SAVED_BINDING_CHANGED';
    await expect(controller.prepare('task-1')).resolves.toBe('needs_setup');
    expect(state.events).toEqual(['cover', 'unlock', 'uncover:unlock failed']);
    expect(state.covered).toBe(false);
    expect(controller.refusal()).toBe('needs_setup');
  });
});
