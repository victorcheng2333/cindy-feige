import type { Snapshot } from './model';
export function demoSnapshot(): Snapshot {
  const now = Date.now(), reset = (hours: number) => now / 1000 + hours * 3600;
  return { signedIn: true, busy: false, error: null, demo: true, login: { kind: 'idle' }, updatedAt: now, selectedDeviceId: null,
    devices: [
      { deviceId: 'demo-mbp', name: 'M5 MacBook Pro', platform: 'darwin', online: true, remoteControlEnabled: true, error: null, checkedAt: now,
        accounts: [
          { id: 'anthropic', name: 'Claude 工作账号', service: 'Claude', plan: 'Max', updatedAt: now, failed: false,
            windows: [{ minutes: 300, remaining: 68, resetsAt: reset(2.3) }, { minutes: 10080, remaining: 42, resetsAt: reset(51) },
              { minutes: 10080, remaining: 73, resetsAt: reset(51), label: 'Sonnet' }] },
          { id: 'openai', name: 'ChatGPT 个人账号', service: 'ChatGPT', plan: 'Pro', updatedAt: now, failed: false,
            windows: [{ minutes: 300, remaining: 22, resetsAt: reset(3.1) }, { minutes: 10080, remaining: 76, resetsAt: reset(74) }] },
        ] },
      { deviceId: 'demo-studio', name: '办公室 Mac Studio', platform: 'darwin', online: false, remoteControlEnabled: true,
        error: null, checkedAt: null, accounts: [] },
    ] };
}
