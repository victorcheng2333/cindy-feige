/**
 * 测试价值
 * - 生产入口与可观察结果:setHarnessEnabled / selectableHarnesses / readDisabledHarnesses
 *   (maker:list-available-agents 与设置页 IPC 直接调用它们);观察盘上文件、可选清单与变化通知。
 * - 规则依据:docs/product-rules/harness-toggles.md —— 关掉只影响新的选择、至少保留一个、
 *   只记关掉的且保留未知 id、偏好不能让这台电脑一个引擎都选不了。
 * - 现有覆盖缺口:新模块,没有相邻测试。
 * - 最小失败输入:registered=['claude-code','codex'] 时关掉 codex 再关 claude-code;
 *   手改文件写入未来 id 与非法值。
 * - tier:unit(真实临时目录读写,不起 Electron)。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logger-adapter.js', () => ({
  desktopMakerLogger: { child: () => ({ info: vi.fn(), warn: vi.fn() }) },
}));

import { configureUserDataDir } from '../../userDataPath.js';
import {
  HarnessPreferenceError,
  onHarnessPreferencesChanged,
  readDisabledHarnesses,
  resetHarnessPreferences,
  selectableHarnesses,
  setHarnessEnabled,
} from '../harness-preferences-store.js';

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-harness-preferences-'));
const file = path.join(tempRoot, 'harness-preferences.json');
configureUserDataDir(tempRoot);

const registered = ['claude-code', 'codex'] as const;

beforeEach(async () => {
  await resetHarnessPreferences();
});

afterAll(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe('harness preferences', () => {
  it('hides a turned-off harness from new choices only, persists it, and notifies once per change', async () => {
    const changed = vi.fn();
    const off = onHarnessPreferencesChanged(changed);

    await setHarnessEnabled('codex', false, registered);
    expect(JSON.parse(fs.readFileSync(file, 'utf-8'))).toEqual({ disabled: ['codex'] });
    expect(selectableHarnesses(registered)).toEqual(['claude-code']);
    // 执行侧的已注册清单不被改动:调用方传入的数组原样保留。
    expect(registered).toEqual(['claude-code', 'codex']);

    await setHarnessEnabled('codex', false, registered);
    expect(changed).toHaveBeenCalledTimes(1);

    await setHarnessEnabled('codex', true, registered);
    expect(selectableHarnesses(registered)).toEqual(['claude-code', 'codex']);
    expect(changed).toHaveBeenCalledTimes(2);
    off();
  });

  it('refuses to turn off the last enabled registered harness but allows unregistered ones', async () => {
    await setHarnessEnabled('codex', false, registered);
    await expect(setHarnessEnabled('claude-code', false, registered)).rejects.toMatchObject({
      code: 'LAST_HARNESS',
    } satisfies Partial<HarnessPreferenceError>);
    expect([...readDisabledHarnesses()]).toEqual(['codex']);

    // Pi 没装好(未注册)时也能预先关掉,不受「至少保留一个」限制。
    await setHarnessEnabled('pi', false, registered);
    expect([...readDisabledHarnesses()].sort()).toEqual(['codex', 'pi']);
  });

  it('keeps unknown future ids from a hand-edited file and never leaves the computer with no choice', () => {
    fs.writeFileSync(file, JSON.stringify({ disabled: ['claude-code', 'codex', 'future-harness', 'Bad Id', 42] }));
    expect([...readDisabledHarnesses()]).toEqual(['claude-code', 'codex', 'future-harness']);
    // 手改关掉了全部已注册引擎:可选清单退回全部已注册,而不是空。
    expect(selectableHarnesses(registered)).toEqual(['claude-code', 'codex']);
  });
});
