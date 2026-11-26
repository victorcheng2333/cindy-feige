/** Maps persisted task engine identifiers to their runtime equivalents. */
/** DB(sessions.agent_kind)与 renderer 侧的 agent 形态。 */
export type DbAgentKind = 'cc' | 'codex' | 'pi' | 'antigravity';
/** maker-core / IPC 契约侧的 agent 形态。 */
export type MakerAgentKindWire = 'claude-code' | 'codex' | 'pi' | 'antigravity';

export function dbToMakerAgentKind(db: string | null | undefined): MakerAgentKindWire {
  if (db === 'antigravity') return 'antigravity';
  if (db === 'codex') return 'codex';
  if (db === 'pi') return 'pi';
  return 'claude-code'; // 'cc' 与历史缺省
}

export function makerToDbAgentKind(maker: string | null | undefined): DbAgentKind {
  if (maker === 'antigravity') return 'antigravity';
  if (maker === 'codex') return 'codex';
  if (maker === 'pi') return 'pi';
  return 'cc'; // 'claude-code' 与历史缺省
}

/** 宽输入归一成 DbAgentKind;非法值回落 'cc'(与 sessions 表 default 同语义)。 */
export function normalizeDbAgentKind(value: string | null | undefined): DbAgentKind {
  return value === 'antigravity' || value === 'codex' || value === 'pi' ? value : 'cc';
}

/**
 * 插件提供的 ACP 执行引擎(docs/plans/acp-plugin-bridge.md)。只在任务生命周期路径
 * (建任务、恢复、落库)使用下面的 Engine 版本;跨设备、模型选择与工具参数仍只认
 * 上面的内置形态，保留 fork 已有的 Antigravity 标识。
 */
export type DbEngineKind = DbAgentKind | 'acp';
export type MakerEngineKindWire = MakerAgentKindWire | 'acp';

export function dbToMakerEngineKind(db: string | null | undefined): MakerEngineKindWire {
  return db === 'acp' ? 'acp' : dbToMakerAgentKind(db);
}

export function makerToDbEngineKind(maker: string | null | undefined): DbEngineKind {
  return maker === 'acp' ? 'acp' : makerToDbAgentKind(maker);
}

/** sessions.agent_kind 是否为插件引擎任务(DB 与 maker 形态同值)。 */
export function isPluginEngineKind(kind: string | null | undefined): kind is 'acp' {
  return kind === 'acp';
}
