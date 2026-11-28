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
 * 插件提供的 ACP 执行引擎（docs/dev-rules/acp-plugin-harness.md）。
 * 所有会接触插件引擎（acp）的任务、界面、归因、调度、IM、Orca、远程与 MCP 路径一律使用
 * 下面的 Engine 版本与穷举分发函数，不要再退回内置转换函数把 acp 误判成 cc / claude-code。
 * 上面仅限内置引擎的函数保留 fork 已有的 Antigravity 标识，只用于明确限定内置引擎的目录与旧 wire 兼容层。
 */
export type DbEngineKind = DbAgentKind | 'acp';
export type MakerEngineKindWire = MakerAgentKindWire | 'acp';

export const ALL_DB_ENGINE_KINDS: readonly DbEngineKind[] = ['cc', 'codex', 'pi', 'antigravity', 'acp'];
export const ALL_MAKER_ENGINE_KINDS: readonly MakerEngineKindWire[] = ['claude-code', 'codex', 'pi', 'antigravity', 'acp'];

export function isDbEngineKind(value: unknown): value is DbEngineKind {
  return value === 'cc' || value === 'codex' || value === 'pi' || value === 'antigravity' || value === 'acp';
}

export function isMakerEngineKind(value: unknown): value is MakerEngineKindWire {
  return value === 'claude-code' || value === 'codex' || value === 'pi' || value === 'antigravity' || value === 'acp';
}

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

/** 宽输入归一成 DbEngineKind;保留插件引擎 'acp',其余回落同 normalizeDbAgentKind。 */
export function normalizeDbEngineKind(value: string | null | undefined): DbEngineKind {
  return value === 'acp' ? 'acp' : normalizeDbAgentKind(value);
}

/** 编译期穷举 DbEngineKind（cc / codex / pi / acp），防止遗漏插件引擎或隐式回落 cc。 */
export function matchDbEngineKind<T>(kind: DbEngineKind, handlers: Readonly<Record<DbEngineKind, () => T>>): T {
  switch (kind) {
    case 'cc':
      return handlers.cc();
    case 'codex':
      return handlers.codex();
    case 'pi':
      return handlers.pi();
    case 'antigravity':
      return handlers.antigravity();
    case 'acp':
      return handlers.acp();
    default: {
      const unexpected: never = kind;
      throw new Error(`Unhandled DbEngineKind: ${String(unexpected)}`);
    }
  }
}

/** 编译期穷举 MakerEngineKindWire（claude-code / codex / pi / acp），防止遗漏插件引擎或隐式回落 Claude。 */
export function matchMakerEngineKind<T>(
  kind: MakerEngineKindWire,
  handlers: Readonly<Record<MakerEngineKindWire, () => T>>,
): T {
  switch (kind) {
    case 'claude-code':
      return handlers['claude-code']();
    case 'codex':
      return handlers.codex();
    case 'pi':
      return handlers.pi();
    case 'antigravity':
      return handlers.antigravity();
    case 'acp':
      return handlers.acp();
    default: {
      const unexpected: never = kind;
      throw new Error(`Unhandled MakerEngineKindWire: ${String(unexpected)}`);
    }
  }
}
