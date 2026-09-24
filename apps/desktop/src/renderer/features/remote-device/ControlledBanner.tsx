import { Button } from '@/components/ui/button';
/**
 * ControlledBanner —— 被控端可见性指示。
 *
 * 同账号设备持有任务订阅时，仅在新任务页右下角显示连接提示；
 * 订阅数量不是桌面键鼠控制者数量，实际桌面控制由 RemoteDesktopHost 显示。
 * 「动态状态点 + <设备名> 已连接到 Cindy + 撤销访问权限」。MainLayout 常驻挂载，
 * 组件按当前路由限制展示，存量任务及其它页面均不显示。状态订阅来自
 * device-link:controlled-state push,初值经 getState().controlledBy。
 *
 * 单设备时按钮调 revoke(deviceId)(逐设备黑名单,持久化);多设备时跳转到设置页,
 * 让用户逐台查看 / 撤销。撤销后控制端连不回来,需被控端到设置「控制本机的设备」里手动恢复。
 *
 * chip 文字不可选中(select-none) —— 它是状态指示而非可复制内容;hover 弹 Tip,展示
 * 完整设备名 + 远程控制逻辑说明。
 */

import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import { Eye, MonitorOff } from 'lucide-react';

import { toast } from '@/lib/toast';
import { createLogger } from '@/lib/logger';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { Tip } from '@/components/ui/tooltip';

const log = createLogger('ControlledBanner');

interface Controller {
  deviceId: string;
  name: string;
}

/**
 * 共享的「谁在控制本机」状态 —— 提到组件之上、模块级单例缓存 + 单一订阅。
 *
 * 状态订阅独立于页面显隐，回到新任务页时使用最新快照，避免重新查询造成闪空。
 */
let cachedControllers: Controller[] = [];
let pushSubscribed = false;
let controllerRevision = 0;
const controllerListeners = new Set<(c: Controller[]) => void>();

export function __resetControlledBannerForTests(): void {
  cachedControllers = [];
  pushSubscribed = false;
  controllerRevision++;
  controllerListeners.clear();
}

function emitControllers(next: Controller[]) {
  controllerRevision++;
  cachedControllers = next;
  for (const listener of controllerListeners) listener(next);
}

// 首个 ControlledBanner 实例挂载时建立一次性订阅(初值 getState + 后续 push),之后常驻 app
// 生命周期:这是单条轻量 IPC 监听,换来跨 remount 的状态连续性,故不在每个实例卸载时反复拆装。
function ensureControllerSubscription() {
  if (pushSubscribed) return;
  if (typeof window === 'undefined' || !window.electronAPI?.deviceLink) return;
  pushSubscribed = true;
  window.electronAPI.deviceLink.onControlledState((p) => emitControllers(p.controllers ?? []));
  const revision = controllerRevision;
  void window.electronAPI.deviceLink
    .getState()
    .then((s) => {
      // A device may disconnect while the initial snapshot is in flight.
      if (revision === controllerRevision) emitControllers(s.controlledBy ?? []);
    })
    .catch(() => {});
}

// 读共享的被控状态:首帧同步返回模块级缓存(remount 不再闪空),后续随 push 更新。
/**
 * 状态由本模块的单例订阅维护，显隐变化不会建立额外 IPC 监听。
 */
function useControlledBy(): Controller[] {
  const [controllers, setControllers] = useState<Controller[]>(cachedControllers);
  useEffect(() => {
    ensureControllerSubscription();
    // 挂载瞬间把本地 state 对齐到最新缓存(可能在本实例上次卸载后又被 push 更新过)。
    setControllers(cachedControllers);
    controllerListeners.add(setControllers);
    return () => {
      controllerListeners.delete(setControllers);
    };
  }, []);
  return controllers;
}

export function ControlledBanner() {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const controllers = useControlledBy();

  if (pathname !== '/cc-agent/new' || controllers.length === 0) return null;

  const label =
    controllers.length === 1
      ? t('remoteDevice.controlledBy', { name: controllers[0].name })
      : t('remoteDevice.controlledByMultiple', { count: controllers.length });
  const hasMultipleControllers = controllers.length > 1;

  // 撤销当前控制本机的单台控制端访问权限(逐设备黑名单,持久化)。
  // 此函数仅在 !hasMultipleControllers(即 controllers.length === 1)时被调用。
  // 成功后被控端会踢断链路 + 拒绝后续连接,controlled-state push 清空 → banner 自然消失。
  // 撤销是持久化操作(对方将连不回来、需到设置恢复)→ 先确认,避免误点;单数文案即对应这一台。
  const onRevoke = async () => {
    // 快照点击那一刻展示的那台控制端(单数文案描述的就是它),确认后只撤它——**不**重读整列表:
    // 否则弹窗 await 期间若第二台接入,会把用户从没在单数文案里见过的新控制端也一起永久拉黑,
    // 且绕过多控制端本应走的「跳设置页」路径(reviewer)。
    const target = controllers[0];
    if (!target) return;
    const ok = await confirm({
      title: t('settings.remoteControl.revokeConfirm.title'),
      description: t('settings.remoteControl.revokeConfirm.description'),
      confirmText: t('settings.remoteControl.revokeConfirm.confirm'),
    });
    if (!ok) return;
    try {
      await window.electronAPI.deviceLink.revoke(target.deviceId);
      toast.success(t('settings.remoteControl.toast.revoked'));
    } catch (err) {
      log.warn('revoke failed', err);
      toast.error(t('settings.remoteControl.toast.revokeFailed'));
    }
  };
  const onViewControllers = () => {
    navigate('/settings?tab=remote-control');
  };

  // hover Tip:第一行完整 label(设备名不截断,窄宽时 chip 里那行会 truncate),
  // 第二行解释远程控制逻辑(可撤销 / 撤销后果 / 在哪恢复)。
  const tooltipContent = (
    <div className="space-y-1">
      <div className="font-medium">{label}</div>
      {hasMultipleControllers && (
        <div>{controllers.map((controller) => controller.name).join(' · ')}</div>
      )}
      <div className="opacity-80">{t('remoteDevice.controlledTooltip')}</div>
    </div>
  );

  const chip = (
    <Tip text={tooltipContent}>
      <div
        data-controlled-banner-chip="true"
        className="pointer-events-auto flex h-7 min-w-0 max-w-full select-none items-center gap-2 overflow-hidden rounded-full border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-0 shadow-[var(--shadow-menu)]"
      >
        <span
          className="session-status-breathing h-1.5 w-1.5 rounded-full"
          style={{ backgroundColor: 'var(--status-bar-accent)' }}
          aria-hidden
        />
        <span className="min-w-0 truncate text-12 text-[var(--text-primary)]">{label}</span>
        <Button
          variant="secondary"
          size="sm"
          tone="quiet"
          compact
          type="button"
          onClick={hasMultipleControllers ? onViewControllers : () => void onRevoke()}
          className="min-w-0 max-w-[45%] shrink"
        >
          {hasMultipleControllers ? (
            <Eye size={13} className="shrink-0" />
          ) : (
            <MonitorOff size={13} className="shrink-0" />
          )}
          <span className="min-w-0 truncate">
            {hasMultipleControllers
              ? t('remoteDevice.viewControllers')
              : t('remoteDevice.revokeAccess')}
          </span>
        </Button>
      </div>
    </Tip>
  );

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex max-w-[calc(100vw-2rem)]">
      {chip}
    </div>
  );
}
