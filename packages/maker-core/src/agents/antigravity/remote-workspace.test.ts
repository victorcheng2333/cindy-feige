/**
 * Tier: unit.
 * Production entry: `AntigravityAgent.startSession` (`deviceHosted`) and `remote-workspace.ts`.
 * Verifies the restricted `--agent cindy-remote` launch, tunnel MCP routing (`cindy_exec`),
 * MCP tool unwrapping, fail-closed version gate (< 1.5.13), guest rejection, immediate
 * termination when Agy attempts any local file or shell tool on the Agent computer, and
 * restarting Agy when it falls back to its default agent instead of loading `cindy-remote`.
 */
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createConsoleLogger } from '../../interfaces/logger.js';
import type { AgentEvent } from '../../types/events.js';
import type { AgentSessionHandle, DeviceHostedSession, StartSessionOptions } from '../base-agent.js';
import { AntigravityAgent } from './index.js';
import {
  ANTIGRAVITY_REMOTE_AGENT_NAME,
  buildAntigravityHostedMcpServers,
  buildAntigravityRemoteAgentDefinition,
  createAntigravityRemoteWorkspaceGuard,
  isAntigravityRemoteWorkspaceVersionSupported,
} from './remote-workspace.js';

vi.mock('node:child_process', async (load) => ({
  ...await load<typeof import('node:child_process')>(),
  spawn: vi.fn(),
}));

const spawnMock = vi.mocked(spawn);

function sampleHosted(overrides: Partial<DeviceHostedSession> = {}): DeviceHostedSession {
  return {
    workingDir: '/virtual/project',
    platform: 'darwin',
    shell: 'zsh',
    extraDirs: [],
    writableDirs: [],
    isGitRepo: true,
    tunnelUrl: 'http://127.0.0.1:45555',
    tunnelToken: 'secret-tunnel-token',
    mcpServers: ['cindy_memory', 'cindy'],
    ...overrides,
  };
}

type RpcMsg = { id?: number | string; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown> };

class FakeRemoteAgyProcess extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly incoming: RpcMsg[] = [];
  readonly permissionResponses: RpcMsg[] = [];
  private readonly sessionId = 'remote-acp-1';
  private onPrompt?: (proc: FakeRemoteAgyProcess, id: number | string) => void;
  private onNewSession?: () => Promise<void>;

  constructor(
    onPrompt?: (proc: FakeRemoteAgyProcess, id: number | string) => void,
    onNewSession?: () => Promise<void>,
  ) {
    super();
    this.onPrompt = onPrompt;
    this.onNewSession = onNewSession;
    let buf = '';
    this.stdin.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      let idx: number;
      while ((idx = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line) continue;
        this.handleMessage(JSON.parse(line) as RpcMsg);
      }
    });
    this.stdin.once('finish', () => this.emit('close'));
    spawnMock.mockReturnValueOnce(this as unknown as ReturnType<typeof spawn>);
  }

  send(payload: Record<string, unknown>) {
    this.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...payload }) + '\n');
  }

  private handleMessage(msg: RpcMsg) {
    this.incoming.push(msg);
    if (msg.method === undefined) {
      this.permissionResponses.push(msg);
      this.emit('permission-response', msg);
      return;
    }
    if (msg.id === undefined) return;
    switch (msg.method) {
      case 'initialize':
        this.send({
          id: msg.id,
          result: {
            protocolVersion: 1,
            agentCapabilities: {
              mcpCapabilities: { http: true },
              sessionCapabilities: { resume: {}, close: {}, additionalDirectories: {} },
              _meta: { antigravity: { systemPrompt: { append: true } } },
            },
            authMethods: [{ id: 'oauth-personal', name: 'Google' }],
          },
        });
        break;
      case 'session/new': {
        const id = msg.id;
        void (this.onNewSession?.() ?? Promise.resolve()).then(() => this.send({
          id,
          result: {
            sessionId: this.sessionId,
            configOptions: [
              { id: 'model', name: 'Model', type: 'select', currentValue: 'gemini-4-neon', options: [{ value: 'gemini-4-neon', name: 'Gemini 4 Neon' }] },
              { id: 'mode', name: 'Mode', type: 'select', currentValue: 'default', options: [{ value: 'default', name: 'Default' }, { value: 'auto', name: 'Auto' }] },
            ],
          },
        }));
        break;
      }
      case 'session/set_config_option':
        this.send({ id: msg.id, result: {} });
        break;
      case 'session/prompt':
        if (this.onPrompt) {
          this.onPrompt(this, msg.id);
        } else {
          this.send({
            method: 'session/update',
            params: { sessionId: this.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } } },
          });
          this.send({ id: msg.id, result: { stopReason: 'end_turn' } });
        }
        break;
      default:
        this.send({ id: msg.id, result: {} });
    }
  }
}

describe('antigravity remote-workspace helpers', () => {
  it('enforces the minimum agy version 1.5.13 fail-closed', () => {
    expect(isAntigravityRemoteWorkspaceVersionSupported('1.5.12')).toBe(false);
    expect(isAntigravityRemoteWorkspaceVersionSupported('1.4.99')).toBe(false);
    expect(isAntigravityRemoteWorkspaceVersionSupported('')).toBe(false);
    expect(isAntigravityRemoteWorkspaceVersionSupported(null)).toBe(false);
    expect(isAntigravityRemoteWorkspaceVersionSupported('1.5.13')).toBe(true);
    expect(isAntigravityRemoteWorkspaceVersionSupported('agy 1.6.0-beta.2')).toBe(true);
    expect(isAntigravityRemoteWorkspaceVersionSupported('2.0.0')).toBe(true);
  });

  it('builds tunnel MCP servers with cindy_exec first and restricted agent definition without secrets', () => {
    const hosted = sampleHosted({ mcpServers: ['cindy_memory', 'bad server!', 'cindy_exec', 'cindy'] });
    const { servers, serverNames } = buildAntigravityHostedMcpServers(hosted);
    expect(serverNames).toEqual(['cindy_exec', 'cindy_memory', 'cindy']);
    expect(servers).toEqual([
      { type: 'http', name: 'cindy_exec', url: 'http://127.0.0.1:45555/mcp/cindy_exec', headers: [{ name: 'Authorization', value: 'Bearer secret-tunnel-token' }] },
      { type: 'http', name: 'cindy_memory', url: 'http://127.0.0.1:45555/mcp/cindy_memory', headers: [{ name: 'Authorization', value: 'Bearer secret-tunnel-token' }] },
      { type: 'http', name: 'cindy', url: 'http://127.0.0.1:45555/mcp/cindy', headers: [{ name: 'Authorization', value: 'Bearer secret-tunnel-token' }] },
    ]);

    const definition = buildAntigravityRemoteAgentDefinition(hosted, serverNames, '/shadow');
    expect(definition).toContain(`name: ${ANTIGRAVITY_REMOTE_AGENT_NAME}`);
    expect(definition).toContain('  - search_web');
    expect(definition).toContain('  - name: cindy_exec');
    expect(definition).toContain('  - name: cindy_memory');
    expect(definition).not.toContain('secret-tunnel-token');
    expect(definition).not.toContain('127.0.0.1:45555');
  });

  it('rewrites known MCP calls in both Agy formats and blocks any local tool escape attempt', () => {
    const guard = createAntigravityRemoteWorkspaceGuard(['cindy_exec', 'cindy_memory']);

    // New-session nested format + follow-up update without arguments
    const first = guard.inspect({
      toolCallId: 'c1',
      name: 'call_mcp_tool',
      title: 'MCP Tool Bash',
      kind: 'execute',
      rawInput: { ServerName: 'cindy_exec', ToolName: 'Bash', Arguments: { command: 'ls -la' } },
    }, 'permission');
    expect(first).toEqual({
      action: 'rewrite',
      autoApproveOnce: true,
      toolCall: expect.objectContaining({
        toolCallId: 'c1',
        name: 'Bash',
        title: 'Bash',
        kind: 'execute',
        rawInput: { command: 'ls -la' },
      }),
    });

    const followup = guard.inspect({ toolCallId: 'c1', status: 'completed', rawOutput: 'ok' }, 'update');
    expect(followup).toEqual({
      action: 'rewrite',
      toolCall: expect.objectContaining({ toolCallId: 'c1', name: 'Bash', title: 'Bash', kind: 'execute' }),
    });

    // Resumed-session direct format (`mcp_<server>_<tool>`) strips toolSummary
    const resumed = guard.inspect({
      toolCallId: 'c2',
      name: 'mcp_cindy_exec_Edit',
      kind: 'execute',
      rawInput: { file_path: '/virtual/project/a.ts', toolSummary: 'Edit file' },
    }, 'update');
    expect(resumed).toEqual({
      action: 'rewrite',
      toolCall: expect.objectContaining({
        name: 'Edit',
        title: 'Edit',
        kind: 'edit',
        rawInput: { file_path: '/virtual/project/a.ts' },
      }),
    });

    // Other tunnel MCP servers map to mcp__<server>__<tool>
    const memoryCall = guard.inspect({
      toolCallId: 'c3',
      name: 'call_mcp_tool',
      rawInput: { ServerName: 'cindy_memory', ToolName: 'memory_search', Arguments: '{"query":"proxy"}' },
    }, 'update');
    expect(memoryCall).toEqual({
      action: 'rewrite',
      toolCall: expect.objectContaining({
        name: 'mcp__cindy_memory__memory_search',
        title: 'mcp__cindy_memory__memory_search',
        kind: 'other',
        rawInput: { query: 'proxy' },
      }),
    });

    // Local tool escape attempts fail closed (including unknown MCP server names)
    expect(guard.inspect({ toolCallId: 'bad1', name: 'run_command', kind: 'execute', rawInput: { CommandLine: 'whoami' } }, 'update').action).toBe('block');
    expect(guard.inspect({ toolCallId: 'bad2', name: 'view_file', kind: 'read', rawInput: { Path: '/etc/passwd' } }, 'permission').action).toBe('block');
    expect(guard.inspect({ toolCallId: 'bad3', name: 'call_mcp_tool', kind: 'execute', rawInput: { ServerName: 'rogue_local', ToolName: 'Bash' } }, 'update').action).toBe('block');

    // Cloud-only search_web passes through
    expect(guard.inspect({ toolCallId: 'web1', name: 'search_web', kind: 'fetch', rawInput: { query: 'acp' } }, 'update')).toEqual({ action: 'pass' });
  });
});

describe('AntigravityAgent device-hosted remote workspace', () => {
  beforeEach(() => spawnMock.mockReset());

  async function createHarness(cliVersion: string | null = '1.5.13') {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'cindy-agy-remote-e2e-'));
    const stateDir = path.join(dir, 'state');
    const prepareAcp = vi.fn(async () => ({ stateDir, servers: [{ type: 'http' as const, name: 'local_only', url: 'http://127.0.0.1:1/mcp', headers: [] }], dispose: vi.fn() }));
    const agent = new AntigravityAgent({
      binaryPath: '/test/agy',
      logger: createConsoleLogger('agy-remote-test'),
      auth: {
        getState: async () => ({ authenticated: true }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({}),
      },
      runtimeConfig: { systemPrompt: 'Cindy instructions' },
      prepareAcp,
      getEnv: () => ({}),
      localSystemPrompt: 'Local shell notes',
      getDiscoveredCapabilities: () => undefined,
      getCliVersion: async () => cliVersion,
    });
    return { dir, stateDir, agent, prepareAcp, cleanup: () => rm(dir, { recursive: true, force: true }) };
  }

  it('rejects guest sessions and agy versions older than 1.5.13 before spawning', async () => {
    const old = await createHarness('1.5.12');
    try {
      await expect(old.agent.startSession({
        workingDir: old.dir,
        model: 'gemini-4-neon',
        deviceHosted: sampleHosted(),
      } as StartSessionOptions)).rejects.toThrow(/1\.5\.13/);
      expect(spawnMock).not.toHaveBeenCalled();

      await expect(old.agent.startSession({
        workingDir: old.dir,
        model: 'gemini-4-neon',
        deviceHosted: sampleHosted({ guest: true }),
      } as StartSessionOptions)).rejects.toThrow(/own computers only/);
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      await old.cleanup();
    }
  });

  it('launches with --agent cindy-remote, routes tunnel MCPs, unwraps tool events, and cleans up launch dir', async () => {
    const h = await createHarness('1.5.13');
    let handle: AgentSessionHandle | undefined;
    try {
      const proc = new FakeRemoteAgyProcess((p, promptId) => {
        p.send({
          id: 'perm-1',
          method: 'session/request_permission',
          params: {
            sessionId: 'remote-acp-1',
            toolCall: {
              toolCallId: 'tc-1',
              name: 'call_mcp_tool',
              title: 'MCP Tool Bash',
              kind: 'execute',
              rawInput: { ServerName: 'cindy_exec', ToolName: 'Bash', Arguments: { command: 'pwd' } },
            },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
          },
        });
        p.once('permission-response', () => {
          p.send({
            method: 'session/update',
            params: {
              sessionId: 'remote-acp-1',
              update: { sessionUpdate: 'tool_call_update', toolCallId: 'tc-1', status: 'completed', rawOutput: '/virtual/project' },
            },
          });
          p.send({ id: promptId, result: { stopReason: 'end_turn' } });
        });
      });

      handle = await h.agent.startSession({
        workingDir: h.dir,
        model: 'gemini-4-neon',
        permissionMode: 'default',
        writableDirs: ['/virtual/extra'],
        deviceHosted: sampleHosted(),
      } as StartSessionOptions);

      const spawnArgs = spawnMock.mock.calls[0]?.[1] as string[];
      const spawnOpts = spawnMock.mock.calls[0]?.[2] as { cwd: string };
      expect(spawnArgs).toEqual(expect.arrayContaining(['acp', '--process-per-session', '--agent', ANTIGRAVITY_REMOTE_AGENT_NAME]));
      const agentFile = path.join(spawnOpts.cwd, '.agents', 'agents', `${ANTIGRAVITY_REMOTE_AGENT_NAME}.md`);
      expect(existsSync(agentFile)).toBe(true);
      const agentMd = await readFile(agentFile, 'utf8');
      expect(agentMd).toContain('  - search_web');
      expect(agentMd).toContain('  - name: cindy_exec');

      const sessionNew = proc.incoming.find(m => m.method === 'session/new');
      expect(sessionNew?.params).not.toHaveProperty('additionalDirectories');
      // The remote agent has no shell of its own, so local sandbox instructions would contradict its tools.
      const appended = JSON.stringify(sessionNew?.params?._meta);
      expect(appended).toContain('Cindy instructions');
      expect(appended).not.toContain('Local shell notes');
      const sentServers = (sessionNew?.params?.mcpServers as Array<{ name: string }>) ?? [];
      expect(sentServers.map(s => s.name)).toEqual(['cindy_exec', 'cindy_memory', 'cindy']);

      await handle.send({ type: 'user', content: 'Run pwd' });
      const events: AgentEvent[] = [];
      for await (const ev of handle.events()) {
        events.push(ev);
        if (ev.type === 'done' || ev.type === 'error') break;
      }

      // Tunnel MCP permission was auto-approved once locally so the controller's MCP gate owns approval
      expect(proc.permissionResponses).toContainEqual({
        jsonrpc: '2.0',
        id: 'perm-1',
        result: { outcome: { outcome: 'selected', optionId: 'allow' } },
      });
      expect(events).toContainEqual(expect.objectContaining({
        type: 'tool_use',
        // The remote tool keeps its ACP kind for the action summary after unwrapping.
        data: expect.objectContaining({
          toolUseId: 'tc-1',
          toolName: 'Bash',
          input: { command: 'pwd', acpKind: 'execute' },
        }),
      }));
      expect(events.at(-1)).toMatchObject({ type: 'done' });

      await handle.close();
      handle = undefined;
      await vi.waitFor(() => expect(existsSync(spawnOpts.cwd)).toBe(false));
    } finally {
      await handle?.close().catch(() => {});
      await h.cleanup();
    }
  });

  it('rejects and terminates immediately when Agy attempts a local tool in remote-workspace mode', async () => {
    const h = await createHarness('1.5.13');
    let handle: AgentSessionHandle | undefined;
    try {
      const proc = new FakeRemoteAgyProcess((p) => {
        p.send({
          id: 'perm-escape',
          method: 'session/request_permission',
          params: {
            sessionId: 'remote-acp-1',
            toolCall: {
              toolCallId: 'escape-1',
              name: 'run_command',
              kind: 'execute',
              rawInput: { CommandLine: 'cat ~/.ssh/id_rsa' },
            },
            options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }, { optionId: 'deny', name: 'Deny', kind: 'reject_once' }],
          },
        });
      });

      handle = await h.agent.startSession({
        workingDir: h.dir,
        model: 'gemini-4-neon',
        permissionMode: 'default',
        deviceHosted: sampleHosted(),
      } as StartSessionOptions);

      await handle.send({ type: 'user', content: 'Inspect files' });
      const events: AgentEvent[] = [];
      for await (const ev of handle.events()) {
        events.push(ev);
        if (ev.type === 'error' || ev.type === 'done') break;
      }

      expect(proc.permissionResponses).toContainEqual({
        jsonrpc: '2.0',
        id: 'perm-escape',
        result: { outcome: { outcome: 'selected', optionId: 'deny' } },
      });
      expect(events.at(-1)).toMatchObject({
        type: 'error',
        data: { isTerminal: true, reason: 'acp-remote-tool-blocked' },
      });
    } finally {
      await handle?.close().catch(() => {});
      await h.cleanup();
    }
  });

  // Regression (2026-11-23): when Agy could not reach Google at startup it logged
  // `Agent "cindy-remote" not found` and ran its default agent; the first `date` then
  // hit Agy's own run_command and the task stopped with acp-remote-tool-blocked.
  it.each([
    { name: 'restarts Agy once and serves the task from the restricted agent', loads: [false, true] },
    { name: 'gives up before any prompt when every start falls back', loads: [false, false, false] },
  ])('$name', async ({ loads }) => {
    const h = await createHarness('1.5.14');
    let handle: AgentSessionHandle | undefined;
    try {
      const procs = loads.map((loaded, index) => new FakeRemoteAgyProcess(undefined, () => writeFile(
        path.join(h.stateDir, `acp.log.${100 + index}`),
        loaded
          ? 'I1123 server.go:1225] Creating new cascade trajectory (agentScript=true)\n'
          : `W1123 session_handlers.go:83] Agent "${ANTIGRAVITY_REMOTE_AGENT_NAME}" not found, falling back to default\n`,
      )));
      const start = h.agent.startSession({
        workingDir: h.dir,
        model: 'gemini-4-neon',
        permissionMode: 'auto',
        deviceHosted: sampleHosted(),
      } as StartSessionOptions);

      if (loads.at(-1)) {
        handle = await start;
        await handle.send({ type: 'user', content: 'Run date' });
        for await (const ev of handle.events()) if (ev.type === 'done' || ev.type === 'error') break;
      } else {
        await expect(start).rejects.toThrow(/restricted mode/);
      }

      expect(spawnMock).toHaveBeenCalledTimes(loads.length);
      procs.forEach((proc, index) => {
        const prompted = proc.incoming.some(m => m.method === 'session/prompt');
        expect(prompted).toBe(loads[index]);
        if (!loads[index]) expect(proc.stdin.writableEnded).toBe(true);
      });
    } finally {
      await handle?.close().catch(() => {});
      await h.cleanup();
    }
  });
});
