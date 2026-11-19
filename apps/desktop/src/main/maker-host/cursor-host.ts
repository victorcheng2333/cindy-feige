import { t } from '../i18n.desktop.js';
import { CursorAgent } from '@cindy/maker-core';
import type { AgentDeps, McpProvider, Logger } from '@cindy/maker-core';
import {
  cursorAuthAdapter,
  createCursorRpc,
  cursorHostEntry,
  cursorRuntimeAvailable,
  cursorStateDir,
  cursorProvider,
  cursorModelDefinition,
} from './cursor-auth.js';
import { getPiExtraSpawnConfig } from '../mcp-integrations/piEnvironment.desktop.js';
import hostSystemPrompt from './host-system-prompt.md?raw';
import cursorSystemPrompt from './cursor-system-prompt.md?raw';
import { scanLocalCustomizations } from '../skillhub/customizationScanHost.js';
import { readDisabledSkillPaths } from '../skillhub/activationPreferences.js';
import { readUserPrompt } from './user-prompt-settings-store.js';

const CURSOR_MCP_SERVERS = ['cindy_helper', 'cindy'] as const;
const CURSOR_MCP_SERVERS_WITH_MEMORY = ['cindy_helper', 'cindy', 'cindy_memory'] as const;

export function buildCursorAgent(
  providers: McpProvider[],
  logger: Logger,
  makerMemory?: AgentDeps['makerMemory'],
): CursorAgent | null {
  if (!cursorRuntimeAvailable()) return null;
  const agent = new CursorAgent({
    auth: cursorAuthAdapter,
    getModel: cursorModelDefinition,
    scanLocalCustomizations,
    getDisabledSkillPaths: readDisabledSkillPaths,
    binaryPath: cursorHostEntry(),
    // Auth and task execution share the production-safe utility process transport.
    createRpc: () => createCursorRpc(),
    logger,
    makerMemory,
    getRuntimeNotice: (reason) => t(`settings.providers.cursor.${reason}`),
    // Cursor's SDK loads rules from every ancestor directory, so user-level Cursor rules
    // (such as calling Cursor App's rename_chat) still apply; the supplement covers that gap.
    runtimeConfig: {
      systemPrompt: `${hostSystemPrompt.trim()}\n\n${cursorSystemPrompt.trim()}`,
      get makerMemoryEnabled() {
        return makerMemory?.isEnabled() ?? false;
      },
      get userPrompt() {
        return readUserPrompt();
      },
    },
    capabilityRouting: {
      overrides: ['webSearch', 'generateImage'].map((id) => ({
        capabilityId: id === 'webSearch' ? 'web-search' : 'image-generation',
        source: { kind: 'harness-builtin', harness: 'cursor', surface: 'tool', id },
        invocation: 'disabled',
      })),
    },
    getStateDir: async (opts) => {
      if (!opts.sessionId) throw new Error('Cursor requires a persistent task identity');
      return cursorStateDir(opts.sessionId);
    },
    getMcpServers: async (opts, context) => {
      const memoryEnabled = context?.memoryEnabled === true;
      const bridge = await getPiExtraSpawnConfig(providers, logger, {
        agentKind: 'cursor',
        sessionId: opts.sessionId,
        sessionInstanceId: opts.sessionInstanceId,
        workingDir: opts.workingDir,
        vendorOptions: opts.vendorOptions,
        memoryEnabled,
        ...(context?.memoryScopeKey ? { memoryScopeKey: context.memoryScopeKey } : {}),
        // Each MCP server costs first-run connection time and prompt space. Cursor gets
        // Cindy's host controls, plugin gateway, and shared memory (when enabled); the rest belongs in Skills.
        allowedServerNames: memoryEnabled ? CURSOR_MCP_SERVERS_WITH_MEMORY : CURSOR_MCP_SERVERS,
      });
      const servers = Object.fromEntries(
        (bridge?.mcpBridge?.servers ?? []).map((server) => {
          const headers = server.remote
            ? Object.fromEntries(
                Object.entries(server.remote.headerEnvVars).map(([key, env]) => [
                  key,
                  bridge?.mcpEnv?.[env] ?? '',
                ]),
              )
            : { Authorization: `Bearer ${bridge?.mcpBridge?.token}` };
          return [server.name, { url: server.url, headers }];
        }),
      );
      return { servers, dispose: () => bridge?.disposeSessionCtx?.() };
    },
  });
  // Capabilities are queried independently of provider:list, including during owner changes.
  // Resolve the catalog at read time so a previous owner's models cannot escape from a stale snapshot.
  Object.defineProperty(agent.capabilities, 'availableModels', {
    enumerable: true,
    get: () =>
      (cursorProvider().models.cursor ?? []).map((model) => ({
        id: model.id,
        displayName: model.name,
        contextWindow: model.contextWindow,
        efforts: model.efforts,
        defaultEffort: model.defaultEffort,
        supportsFastMode: model.supportsFastMode,
        supportsImageInput: true,
        effortsUnknown: model.effortsUnknown,
      })),
  });
  return agent;
}
