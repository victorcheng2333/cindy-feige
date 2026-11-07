import { useEffect, useSyncExternalStore } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';

/**
 * 任务运行时点发送的默认方式:排队等这一轮结束,或插话进当前这一轮。与桌面
 * 「任务运行时发送新消息」同义;本机偏好,只存 override(缺省 = 排队)。
 */
export type ComposerRunningSendPreference = 'queue' | 'steer';

export const COMPOSER_RUNNING_SEND_OPTIONS: readonly ComposerRunningSendPreference[] = ['queue', 'steer'];

const key = 'cindy.mobile.composer.running-send.v1';
let current: ComposerRunningSendPreference = 'queue';
let loaded: Promise<void> | undefined;
let revision = 0;
let writes = Promise.resolve();
const listeners = new Set<() => void>();

function parse(raw: string | null): ComposerRunningSendPreference {
  return raw === 'steer' ? 'steer' : 'queue';
}
function notify() {
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
function load() {
  if (!loaded) {
    const initialRevision = revision;
    loaded = AsyncStorage.getItem(key)
      .then((raw) => {
        // 读盘期间用户已改过,以用户的选择为准。
        if (initialRevision === revision) {
          current = parse(raw);
          notify();
        }
      })
      .catch(() => undefined);
  }
  return loaded;
}

export function saveComposerRunningSendPreference(value: ComposerRunningSendPreference): Promise<void> {
  const next = parse(value);
  revision += 1;
  current = next;
  notify();
  const write = writes
    .catch(() => undefined)
    .then(() => (next === 'queue' ? AsyncStorage.removeItem(key) : AsyncStorage.setItem(key, next)));
  writes = write;
  return write;
}

export function useComposerRunningSendPreference() {
  const preference = useSyncExternalStore(subscribe, () => current, () => 'queue' as const);
  useEffect(() => {
    void load();
  }, []);
  return { preference, setPreference: saveComposerRunningSendPreference };
}
