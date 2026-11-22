/**
 * modelDefinitions 的 deviceId 透传单测(device-link「以被控端为准」)。
 * 模型 id 跨设备不唯一(fork 自定义 contextWindow / 折扣路由),远程会话必须读被控端 caps —— 不能用本地替代。
 * 复用 useAgentCapabilities 的同一份模块级缓存，保留跨设备隔离。
 */
import { describe, expect, it, vi } from 'vitest';
import * as capsMod from '@/hooks/useAgentCapabilities';
import * as md from '@/lib/modelDefinitions';


function model(id: string, ctx: number) {
  return { id, displayName: id, contextWindow: ctx, efforts: ['high'], defaultEffort: 'high', supportsFastMode: false };
}

function stubElectron() {
  // 本地 cc: 仅 'm'(ctx=100);本地 codex 空。
  const getCapabilities = vi.fn(async (k: string) => ({
    availableModels:
      k === 'antigravity'
        ? [model('agy-shared', 500)]
        : k === 'cursor'
          ? [model('cursor-shared', 400)]
          : k === 'claude-code'
            ? [model('m', 100)]
            : [],
    hasFastMode: false,
    effortLevels: [],
    permissionModes: [],
  }));
  // dev-1 cc: 'm'(ctx=200,与本地不同)+ 被控端独有 'host-only';dev-1 codex 空。
  const invoke = vi.fn(async (_deviceId: string, _channel: string, args: unknown[]) => ({
    availableModels:
      args[0] === 'antigravity'
        ? [model('agy-shared', 950), model('agy-host-only', 1000)]
        : args[0] === 'cursor'
          ? [model('cursor-shared', 800), model('cursor-host-only', 900)]
          : args[0] === 'claude-code'
            ? [model('m', 200), model('host-only', 300)]
            : [],
    hasFastMode: false,
    effortLevels: [],
    permissionModes: [],
  }));
  vi.stubGlobal('window', { electronAPI: { maker: { getCapabilities }, deviceLink: { invoke } } });
}

describe('modelDefinitions deviceId threading', () => {
  it('getModelById:本地 vs 被控端读各自缓存;被控端独有模型仅带 deviceId 时可解', async () => {
    stubElectron();
    await capsMod.preloadAllCapabilities();
    await capsMod.prefetchDeviceCapabilities('dev-1');

    // 同 id 'm' 但 contextWindow 不同 —— 必须各取各的
    expect(md.getModelById('m')?.contextWindow).toBe(100);
    expect(md.getModelById('m', 'dev-1')?.contextWindow).toBe(200);

    // 被控端独有模型:本地查不到,带 deviceId 才解得出(否则远程会话 UI 会空白)
    expect(md.getModelById('host-only')).toBeUndefined();
    expect(md.getModelById('host-only', 'dev-1')?.id).toBe('host-only');
  });

  it('getModelsForVendor / getEffortsForModel 同样按 deviceId 取', async () => {
    stubElectron();
    await capsMod.preloadAllCapabilities();
    await capsMod.prefetchDeviceCapabilities('dev-1');

    expect(md.getModelsForVendor('cc').map((m) => m.id)).toEqual(['m']);
    expect(md.getModelsForVendor('cc', 'dev-1').map((m) => m.id)).toEqual(['m', 'host-only']);
    expect(md.getEffortsForModel('host-only', 'dev-1')).toEqual(['high']);
    expect(md.getEffortsForModel('host-only')).toEqual([]); // 本地没有
  });
});

// Unit regression: remote Cursor models were excluded from synchronous lookups.
// Existing coverage only queried Claude. The same ID on both devices must retain
// the target's context window, and target-only models must remain selectable.
it('resolves Cursor metadata from the controlled computer', async () => {
  stubElectron();
  await capsMod.preloadAllCapabilities();
  await capsMod.prefetchDeviceCapabilities('dev-1');
  expect(md.getModelsForVendor('cursor', 'dev-1').map(m => m.id))
    .toEqual(['cursor-shared', 'cursor-host-only']);
  expect(md.getModelById('cursor-shared', 'dev-1')?.contextWindow).toBe(800);
  expect(md.getModelById('cursor-shared')?.contextWindow).toBe(400);
  expect(md.getEffortsForModel('cursor-host-only', 'dev-1')).toEqual(['high']);
  expect(md.getModelById('cursor-host-only')).toBeUndefined();
});

it('resolves Antigravity metadata from the controlled computer', async () => {
  stubElectron();
  await capsMod.preloadAllCapabilities();
  await capsMod.prefetchDeviceCapabilities('dev-1');
  expect(md.getModelsForVendor('antigravity', 'dev-1').map(m => m.id))
    .toEqual(['agy-shared', 'agy-host-only']);
  expect(md.getModelById('agy-shared', 'dev-1')?.contextWindow).toBe(950);
  expect(md.getModelById('agy-shared')?.contextWindow).toBe(500);
  expect(md.getEffortsForModel('agy-host-only', 'dev-1')).toEqual(['high']);
  expect(md.getModelById('agy-host-only')).toBeUndefined();
});
