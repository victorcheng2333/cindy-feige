import type { DeviceLinkConnectionStatus } from '@/lib/ccAgent.types';
import type { RemoteDeviceSummary } from '../../device-link/remoteProjectsStore';
import type { SwitcherDevice } from '../../device-link/switcherDevices';

export interface SidebarDeviceInfo {
  name: string;
  /** 不标离线:任务已同步或连接中。只有确认断开的设备才是离线。 */
  online: boolean;
  /** 任务列表已同步;在该设备上新建任务以此为准,连接中与离线都不行。 */
  connected: boolean;
}

/**
 * 分组与设备切换栏共用设备集合；断线只改变状态，不移除保留的设备。
 * 切换栏的 connecting 同时包含「在线未同步 / relay 重连中 / 确认断开」,不能整体当作离线
 * (#9329):状态取自任务同步分片的三态。首拉在途时即使还挂着断开的旧分片,也算连接中。
 */
export function buildSidebarDeviceIndex(
  devices: readonly SwitcherDevice[],
  syncedDevices: readonly Pick<RemoteDeviceSummary, 'deviceId' | 'connectionStatus'>[] = [],
  bootstrapLoadingDeviceIds: ReadonlySet<string> = new Set(),
): Map<string, SidebarDeviceInfo> {
  const shardStatus = new Map<string, DeviceLinkConnectionStatus>(
    syncedDevices.map((device) => [device.deviceId, device.connectionStatus]),
  );
  const index = new Map<string, SidebarDeviceInfo>();
  for (const device of devices) {
    if (device.status === 'rejected') continue;
    const status: DeviceLinkConnectionStatus =
      device.status === 'connected'
        ? 'connected'
        : bootstrapLoadingDeviceIds.has(device.deviceId)
          ? 'connecting'
          : (shardStatus.get(device.deviceId) ?? 'connecting');
    index.set(device.deviceId, {
      name: device.name,
      // 已知 presence 始终优先；目录尚无该设备时，连接中/首拉在途不能被误标为离线。
      online: device.presenceKnown === false ? status !== 'disconnected' : device.online,
      connected: status === 'connected',
    });
  }
  return index;
}
