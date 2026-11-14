import { useEffect, useRef, useState } from 'react';

type SessionAgentKind = 'claude-code' | 'codex' | 'pi';
const SESSION_AGENT_KINDS: readonly SessionAgentKind[] = ['claude-code', 'codex', 'pi'];

/**
 * 已有任务里「切换引擎」可选的 Harness:被控电脑上开着的(maker:list-available-agents,
 * 已扣掉用户在那台电脑上关掉的),当前引擎始终保留。未读到(null)时不过滤。
 */
export function sessionSwitchAgentKinds(
  available: ReadonlySet<string> | null,
  current: SessionAgentKind,
): SessionAgentKind[] {
  return SESSION_AGENT_KINDS.filter((kind) => !available || kind === current || available.has(kind));
}

/**
 * 读取被控电脑当前可选的 Harness,并在它推送 maker:agents:changed 时重读。
 * 只在 active(任务支持切换引擎)时读取;失败保持 null(不过滤,真正的兜底在被控端)。
 */
export function useSelectableAgentKinds(
  deviceId: string | undefined,
  active: boolean,
  listAvailableAgents: () => Promise<unknown>,
  onAgentsChanged: (listener: (deviceId: string) => void) => () => void,
): ReadonlySet<string> | null {
  const [available, setAvailable] = useState<ReadonlySet<string> | null>(null);
  const [nonce, setNonce] = useState(0);
  // 读取函数可能每次渲染换身份;只在设备、开关或推送变化时重读,避免逐帧打隧道。
  const listRef = useRef(listAvailableAgents);
  listRef.current = listAvailableAgents;

  useEffect(() => {
    if (!deviceId || !active) return;
    return onAgentsChanged((changed) => {
      if (changed === deviceId) setNonce((value) => value + 1);
    });
  }, [deviceId, active, onAgentsChanged]);

  useEffect(() => {
    if (!deviceId || !active) {
      setAvailable(null);
      return;
    }
    let cancelled = false;
    listRef.current()
      .then((agents) => {
        if (cancelled || !Array.isArray(agents)) return;
        setAvailable(new Set(agents.filter((agent): agent is string => typeof agent === 'string')));
      })
      .catch(() => {
        /* fail-open:读取失败不隐藏引擎。 */
      });
    return () => {
      cancelled = true;
    };
  }, [deviceId, active, nonce]);

  return available;
}
