/**
 * Remote-workspace mode for device-hosted Antigravity tasks (same-account only).
 *
 * When a task's files live on another computer of the same Cindy account, Agy runs on
 * this computer under a temporary restricted `--agent` definition (`cindy-remote`):
 *  - Agy's own file/shell tools are stripped via the agent's `tools` allow-list
 *    (keeping only `search_web`, which runs at the model service and touches no local files).
 *  - All workspace file/shell actions and Cindy tools go through the task's loopback
 *    tunnel MCP servers (`cindy_exec` + the controller's MCP servers).
 *  - Because Agy offers no pre-flight tool-list introspection, the ACP relay fails closed:
 *    versions below 1.5.13 are refused, and any non-MCP tool call that reads, edits or
 *    executes locally immediately rejects and terminates the Agy process group.
 */
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { DeviceHostedSession } from '../base-agent.js';
import type { AcpMcpServer, AcpToolCallFields } from '../acp/protocol.js';
import {
  DEVICE_HOSTED_EXEC_MCP_SERVER,
  deviceHostedEnvironmentNote,
  deviceHostedMcpUrl,
} from '../shared/device-hosted.js';

export const ANTIGRAVITY_REMOTE_AGENT_NAME = 'cindy-remote';
export const ANTIGRAVITY_REMOTE_WORKSPACE_MIN_VERSION = [1, 5, 13] as const;

const SERVER_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MAX_REMOTE_SERVERS = 64;
const MAX_TRACKED_MCP_CALLS = 2_000;
const LAUNCH_DIR_PREFIX = 'remote-agent-';
const STALE_LAUNCH_DIR_MS = 24 * 60 * 60 * 1000;

/** ACP tool kinds that indicate local filesystem or shell access when not an MCP call. */
export const ANTIGRAVITY_LOCAL_TOOL_KINDS: ReadonlySet<string> = new Set([
  'read', 'edit', 'delete', 'move', 'execute',
]);

/** Agy's own local file and shell tools, by reported name. */
export const ANTIGRAVITY_LOCAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  'view_file', 'multimodal_view_file', 'read_file', 'list_dir', 'find_by_name', 'grep_search', 'code_search',
  'write_to_file', 'write_file', 'create_file', 'edit_file', 'replace_file_content', 'multi_replace_file_content',
  'delete_file', 'move_file', 'run_command', 'command_status', 'send_command_input',
]);

/** Display tool kinds for Cindy's `cindy_exec` remote workspace tools. */
const EXEC_TOOL_KINDS: Readonly<Record<string, string>> = {
  Bash: 'execute',
  BashOutput: 'execute',
  KillShell: 'execute',
  Read: 'read',
  Write: 'edit',
  Edit: 'edit',
  NotebookEdit: 'edit',
  WebFetch: 'fetch',
};

export const ANTIGRAVITY_REMOTE_TOOL_BLOCKED_MESSAGE =
  'Antigravity tried to use a local tool on the Agent computer, so the task was stopped. '
  + "This task's files are on another computer; it may only use the tools that computer provides.";

export const ANTIGRAVITY_REMOTE_AGENT_START_ATTEMPTS = 3;

/**
 * Agy 1.5.14 applies `--agent` definitions only after its startup flags arrive from Google.
 * When those requests fail it logs this line and silently runs its default agent, which
 * still has Agy's own file and shell tools.
 */
const REMOTE_AGENT_FALLBACK_LOG = `Agent "${ANTIGRAVITY_REMOTE_AGENT_NAME}" not found`;

export class AntigravityRemoteAgentUnavailableError extends Error {
  constructor() {
    super(
      'Agy on the Agent computer could not turn on the restricted mode for tasks whose files are on another computer, '
      + "usually because it could not reach Google's servers. Check that computer's network or Agy proxy, then try again.",
    );
    this.name = 'AntigravityRemoteAgentUnavailableError';
  }
}

/** True when an Agy worker started at or after `launchedAtMs` logged that it fell back to its default agent. */
export async function antigravityRemoteAgentFellBack(stateDir: string, launchedAtMs: number): Promise<boolean> {
  const names = await readdir(stateDir).catch(() => [] as string[]);
  for (const name of names) {
    if (!/^acp\.log\.\d+$/.test(name)) continue;
    const file = path.join(stateDir, name);
    const info = await stat(file).catch(() => null);
    if (!info || info.mtimeMs < launchedAtMs) continue;
    if ((await readFile(file, 'utf8').catch(() => '')).includes(REMOTE_AGENT_FALLBACK_LOG)) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `1.5.13`, `agy 1.6.0-beta.2`, ... at or above the checked version. Unreadable versions fail closed. */
export function isAntigravityRemoteWorkspaceVersionSupported(version: string | null | undefined): boolean {
  const match = /(\d+)\.(\d+)\.(\d+)/.exec(typeof version === 'string' ? version : '');
  if (!match) return false;
  for (let i = 0; i < 3; i += 1) {
    const part = Number(match[i + 1]);
    const required = ANTIGRAVITY_REMOTE_WORKSPACE_MIN_VERSION[i]!;
    if (part !== required) return part > required;
  }
  return true;
}

/** Build the tunnel-backed ACP MCP server list (`cindy_exec` + controller servers). */
export function buildAntigravityHostedMcpServers(hosted: DeviceHostedSession): {
  servers: AcpMcpServer[];
  serverNames: string[];
} {
  const rawNames = [DEVICE_HOSTED_EXEC_MCP_SERVER, ...hosted.mcpServers];
  const serverNames: string[] = [];
  const seen = new Set<string>();
  for (const name of rawNames) {
    if (typeof name !== 'string' || !SERVER_NAME_PATTERN.test(name) || seen.has(name)) continue;
    if (serverNames.length >= MAX_REMOTE_SERVERS) break;
    seen.add(name);
    serverNames.push(name);
  }
  const servers: AcpMcpServer[] = serverNames.map(name => ({
    type: 'http',
    name,
    url: deviceHostedMcpUrl(hosted, name),
    headers: [{ name: 'Authorization', value: `Bearer ${hosted.tunnelToken}` }],
  }));
  return { servers, serverNames };
}

/**
 * Restricted Agy agent definition for remote-workspace mode.
 * `tools` is an allow-list of Agy's own tools (`search_web` touches no local machine);
 * `mcpServers` names the tunnel servers only — URLs and tokens stay in `session/new`.
 */
export function buildAntigravityRemoteAgentDefinition(
  hosted: DeviceHostedSession,
  serverNames: readonly string[],
  localWorkingDir: string,
): string {
  const others = serverNames.filter(name => name !== DEVICE_HOSTED_EXEC_MCP_SERVER);
  return [
    '---',
    `name: ${ANTIGRAVITY_REMOTE_AGENT_NAME}`,
    'description: Works on a project that is on another computer, through the tools Cindy provides.',
    'tools:',
    '  - search_web',
    'mcpServers:',
    ...serverNames.map(name => `  - name: ${name}`),
    '---',
    'You are a coding agent running inside Cindy. The project you are working on is on another computer, not on this one.',
    '',
    `You have no file or shell tools of your own in this task. Everything that reads or changes files, or runs commands, goes through the MCP server \`${DEVICE_HOSTED_EXEC_MCP_SERVER}\` (Bash: { command }, BashOutput: { bash_id }, KillShell: { shell_id }, Read: { file_path }, Write: { file_path, content }, Edit: { file_path, old_string, new_string }, NotebookEdit: { notebook_path, new_source }). Those tools run on the computer the project is on.`,
    ...(others.length
      ? [`The other MCP servers of this task (${others.map(name => `\`${name}\``).join(', ')}) are Cindy's own tools on that computer. List a server's tools before you use them.`]
      : []),
    '',
    deviceHostedEnvironmentNote(hosted, localWorkingDir),
    '',
    '- Search files with Bash (rg, find, ls). Read a file before you edit it, and make the smallest change that does the job.',
    '- Never say you read, changed or ran something unless the tool call for it succeeded. If a tool is refused or missing, say so instead of guessing.',
    '',
  ].join('\n');
}

async function pruneStaleLaunchDirs(stateDir: string, now = Date.now()): Promise<void> {
  const names = await readdir(stateDir).catch(() => [] as string[]);
  await Promise.all(
    names
      .filter(name => name.startsWith(LAUNCH_DIR_PREFIX))
      .map(async name => {
        const target = path.join(stateDir, name);
        const info = await stat(target).catch(() => null);
        if (info?.isDirectory() && now - info.mtimeMs > STALE_LAUNCH_DIR_MS) {
          await rm(target, { recursive: true, force: true }).catch(() => {});
        }
      }),
  );
}

/**
 * Prepare an isolated launch directory containing only `.agents/agents/cindy-remote.md`.
 * Passing this directory as `cwd` keeps the remote-agent definition completely separate
 * from both the Agent computer's files and the controller's synced shadow files.
 */
export async function prepareAntigravityRemoteWorkspaceDir(
  stateDir: string,
  hosted: DeviceHostedSession,
  serverNames: readonly string[],
  localWorkingDir: string,
): Promise<{ dir: string; cleanup(): Promise<void> }> {
  await mkdir(stateDir, { recursive: true, mode: 0o700 });
  await pruneStaleLaunchDirs(stateDir);
  const dir = await mkdtemp(path.join(stateDir, LAUNCH_DIR_PREFIX));
  const agentsDir = path.join(dir, '.agents', 'agents');
  await mkdir(agentsDir, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(agentsDir, `${ANTIGRAVITY_REMOTE_AGENT_NAME}.md`),
    buildAntigravityRemoteAgentDefinition(hosted, serverNames, localWorkingDir),
    { encoding: 'utf8', mode: 0o600 },
  );
  let cleaned = false;
  return {
    dir,
    async cleanup() {
      if (cleaned) return;
      cleaned = true;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    },
  };
}

function unwrapMcpArguments(input: Record<string, unknown>): Record<string, unknown> {
  const value = input.Arguments;
  if (isRecord(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : { value: parsed };
    } catch {
      return { value };
    }
  }
  return {};
}

/** `mcp_cindy_exec_Bash` -> `{ server: 'cindy_exec', tool: 'Bash' }` for a session server. */
function matchDirectMcpTool(name: string | undefined, serverNames: readonly string[]): { server: string; tool: string } | null {
  if (!name || !name.startsWith('mcp_')) return null;
  let found: { server: string; tool: string } | null = null;
  for (const server of serverNames) {
    const prefix = `mcp_${server.replace(/[^A-Za-z0-9_]/g, '_')}_`;
    if (name.startsWith(prefix) && name.length > prefix.length && (!found || server.length > found.server.length)) {
      found = { server, tool: name.slice(prefix.length) };
    }
  }
  return found;
}

export type AntigravityRemoteToolVerdict =
  | { action: 'pass' }
  | { action: 'rewrite'; toolCall: AcpToolCallFields; autoApproveOnce?: boolean }
  | { action: 'block'; reason: string; tool: string };

/**
 * Inspect ACP tool updates and permission requests for a remote-workspace session:
 *  - Recognises MCP calls to the session's tunnel servers in both forms Agy 1.5.13 emits
 *    (`call_mcp_tool` with nested `{ ServerName, ToolName, Arguments }` in new sessions,
 *    and `mcp_<server>_<tool>` in resumed sessions), rewrites them to Cindy's tool names
 *    (`Bash`, `Read`, ..., or `mcp__<server>__<tool>`), and hands permission gating off to
 *    the task computer's MCP approval layer (`autoApproveOnce: true`).
 *  - Fails closed (`block`) on any non-MCP tool call that reads, edits or executes locally.
 */
export function createAntigravityRemoteWorkspaceGuard(serverNames: readonly string[]) {
  const allowedServers = new Set(serverNames);
  const seenMcpCalls = new Map<string, { title: string; kind: string }>();

  function inspect(toolCall: AcpToolCallFields, source: 'update' | 'permission'): AntigravityRemoteToolVerdict {
    const id = toolCall.toolCallId;
    const raw = toolCall.rawInput;
    const nested = isRecord(raw) && typeof raw.ServerName === 'string' && typeof raw.ToolName === 'string'
      && allowedServers.has(raw.ServerName)
      ? { server: raw.ServerName, tool: raw.ToolName }
      : null;
    const direct = nested ? null : matchDirectMcpTool(toolCall.name, serverNames);
    const matched = nested ?? direct;
    let known = id ? seenMcpCalls.get(id) : undefined;
    if (matched) {
      const isExec = matched.server === DEVICE_HOSTED_EXEC_MCP_SERVER;
      known = {
        title: isExec ? matched.tool : `mcp__${matched.server}__${matched.tool}`,
        kind: isExec ? (EXEC_TOOL_KINDS[matched.tool] ?? 'other') : 'other',
      };
      if (id) {
        if (seenMcpCalls.size >= MAX_TRACKED_MCP_CALLS && !seenMcpCalls.has(id)) {
          const oldest = seenMcpCalls.keys().next().value;
          if (oldest !== undefined) seenMcpCalls.delete(oldest);
        }
        seenMcpCalls.set(id, known);
      }
    }
    if (known) {
      const next: AcpToolCallFields = {
        ...toolCall,
        title: known.title,
        name: known.title,
        kind: known.kind,
      };
      if (nested && isRecord(raw)) {
        next.rawInput = unwrapMcpArguments(raw);
      } else if (direct && isRecord(raw) && 'toolSummary' in raw) {
        const { toolSummary: _summary, ...rest } = raw;
        next.rawInput = rest;
      }
      return {
        action: 'rewrite',
        toolCall: next,
        // Real authorization runs on the task computer's MCP router/ExecutorGate;
        // release Agy's local one-time prompt so the request reaches the tunnel without double-prompting.
        ...(source === 'permission' ? { autoApproveOnce: true } : {}),
      };
    }

    const name = toolCall.name ?? '';
    const kind = toolCall.kind ?? '';
    if (ANTIGRAVITY_LOCAL_TOOL_NAMES.has(name) || ANTIGRAVITY_LOCAL_TOOL_KINDS.has(kind)) {
      return {
        action: 'block',
        reason: ANTIGRAVITY_REMOTE_TOOL_BLOCKED_MESSAGE,
        tool: name || kind,
      };
    }
    return { action: 'pass' };
  }

  return { inspect };
}
