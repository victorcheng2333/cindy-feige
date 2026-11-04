import type { JPushLifecycle } from './jpushLifecycle';

// Native binding is installed by PushNotificationsBridge; pure registration logic stays SDK-free.
export let jpushLifecycle: JPushLifecycle | null = null;
export let jpushEnabled = false;
export function installJPushRuntime(value: JPushLifecycle | null) {
  jpushLifecycle = value;
  jpushEnabled = value !== null;
}
