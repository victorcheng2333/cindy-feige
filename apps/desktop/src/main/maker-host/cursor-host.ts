import { t } from '../i18n.js';
import { CursorAgent } from '@cindy/maker-core';
import type { McpProvider, Logger } from '@cindy/maker-core';
import {
  cursorAuthAdapter,
  createCursorRpc,
  cursorHostEntry,
  cursorRuntimeAvailable,
  cursorStateDir,
  cursorProvider,
  cursorModelDefinition,
} from './cursor-auth.js';
import { getPiExtraSpawnConfig } from '../mcp-integrations/piEnvironment.js';
import hostSystemPrompt from './host-system-prompt.md?raw';
import { scanLocalCustomizations } from '../skillhub/customizationScanHost.js';
import { readDisabledSkillPaths } from '../skillhub/activationPreferences.js';

export function buildCursorAgent(providers: McpProvider[], logger: Logger): CursorAgent | null {
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
    getRuntimeNotice: (reason) => t(`settings.providers.cursor.${reason}`),
    runtimeConfig: { systemPrompt: hostSystemPrompt },
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
    getMcpServers: async (opts) => {
      const bridge = await getPiExtraSpawnConfig(providers, logger, {
        agentKind: 'cursor',
        sessionId: opts.sessionId,
        sessionInstanceId: opts.sessionInstanceId,
        workingDir: opts.workingDir,
        vendorOptions: opts.vendorOptions,
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
