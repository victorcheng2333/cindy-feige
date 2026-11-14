/** 这台电脑的 Harness 开关在 main 与设置页之间的视图(main/maker-host/harness-preferences-store.ts)。 */
export interface HarnessPreferenceEntry {
  /** Harness id,与 AgentKind 同值(如 'codex')。 */
  kind: string;
  /** 这台电脑上已注册、可以运行(Pi 没装好时为 false)。 */
  registered: boolean;
  /** 用户没关掉;关掉的不再出现在模型选择器等新的选择入口。 */
  enabled: boolean;
}

export interface HarnessPreferencesView {
  harnesses: HarnessPreferenceEntry[];
}
