import { requireOptionalNativeModule } from 'expo-modules-core';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import { Platform } from 'react-native';
import { parseJPushRegistration } from '@cindy/device-link';
import { JPushLifecycle } from './jpushLifecycle';
import { installJPushRuntime } from './jpushRuntime';

const native = Platform.OS === 'ios' ? requireOptionalNativeModule<{
  config(): { appKey: string; production: boolean } | null;
  bind(alias: string): Promise<void>;
  disable(): Promise<void>;
  setGate(alias: string, preview: boolean): boolean;
  accepts(alias: string): boolean;
}>('CindyJPush') : null;
const config = native?.config() ?? null;
const KEY = 'cindy.jpush.registration.v1';
const listeners = new Set<() => void>();
export const jpushEnabled = config !== null;
export const jpushLifecycle = config && native ? new JPushLifecycle({
  config,
  async read() {
    const raw = await SecureStore.getItemAsync(KEY);
    if (!raw) return null;
    const value = JSON.parse(raw);
    const registration = parseJPushRegistration(value.registration);
    if (!registration || typeof value.owner !== 'string') throw new Error('JPUSH_STATE_INVALID');
    return { owner: value.owner, registration, pendingRemoval: value.pendingRemoval === true };
  },
  write: value => SecureStore.setItemAsync(KEY, JSON.stringify(value)),
  remove: () => SecureStore.deleteItemAsync(KEY),
  randomAlias: () => `cindy_${Crypto.randomUUID().replaceAll('-', '')}`,
  bind: alias => native.bind(alias),
  disable: () => native.disable(),
  gate: (alias, preview) => native.setGate(alias, preview),
  changed: () => { for (const listener of listeners) listener(); },
}) : null;
installJPushRuntime(jpushLifecycle);

export function subscribeJPush(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; }

/** Reject notification taps for a former account/preview generation. */
export function acceptsJPushResponse(response: unknown): boolean {
  const r = response as { notification?: { request?: { content?: { data?: Record<string, unknown> }; trigger?: { payload?: Record<string, unknown> } } } } | null;
  const request = r?.notification?.request;
  const alias = request?.trigger?.payload?.cindyPushAlias ?? request?.content?.data?.cindyPushAlias;
  return typeof alias !== 'string' || native?.accepts(alias) === true;
}
