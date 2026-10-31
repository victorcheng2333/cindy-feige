/**
 * 远程 Agent 反向 HTTP 请求的本机路由(控制端)。
 *
 * 对方电脑上的 Agent 经它本机隧道发来的 HTTP 请求在这里落地：
 *  - `/exec/<op>`：执行器原始操作(Pi 的工具后端)，JSON 进 JSON 出；
 *  - `/mcp/cindy_exec`：Claude Code 风格文件与命令工具(MCP)；
 *  - `/mcp/<name>`：本机 Cindy 工具(MCP)，转发到本机 MCP 桥，身份固定为本任务(对方给的
 *    查询参数一律丢弃，不能借它冒用别的任务)。
 * 其余路径一律 404。
 */
import { fileURLToPath } from 'node:url';
import type { RemoteAgentReply } from '@cindy/device-link';

import { CINDY_EXEC_MCP_SERVER, handleExecMcpRequest } from '../executor/ccMcp';
import { ExecutorRequestError, type RemoteExecutor } from '../executor/executor';
import { resolveExecutorShell } from '../executor/shell';
import { pathTextContext, type ExecutorWorkspace } from '../executor/workspace';

/** 本任务可用的一个本机 MCP 服务：完整地址(已带本任务身份)与要附加的请求头。 */
export interface LocalMcpTarget {
  url: string;
  headers: Record<string, string>;
}

export interface ReverseHttpRouterDeps {
  /** The caller granted its own tools only, not access to native file/shell tools. */
  hostToolsOnly?: boolean;
  /** Runs on the task computer immediately before a shared Claude tool executes. */
  approve?<T>(name: string, input: Record<string, unknown>, execute: (approved: Record<string, unknown>) => Promise<T>, signal?: AbortSignal): Promise<T>;
  executor: RemoteExecutor;
  /** 本任务可用的本机 MCP 服务，按名字查。 */
  mcpTarget(name: string): LocalMcpTarget | undefined;
  fetch?: typeof fetch;
}

const FORWARD_REQUEST_HEADERS = new Set(['content-type', 'accept', 'mcp-session-id', 'mcp-protocol-version', 'last-event-id']);
const FORWARD_RESPONSE_HEADERS = new Set(['content-type', 'mcp-session-id', 'mcp-protocol-version']);

/** 本机工具已有的路径参数；兼容 MCP snake_case 与宿主 camelCase，正文和插件业务参数不做文本替换。 */
const PATH_ARGUMENTS = new Set([
  'path', 'paths', 'filepath', 'filepaths', 'directory', 'directories', 'dir', 'dirs',
  'workingdir', 'workdir', 'cwd', 'root', 'libraryroot', 'sourcepath', 'destinationpath',
  'savedir', 'outpath', 'htmlpath', 'imagepath', 'iconsource', 'attachments', 'extradirs', 'writabledirs',
  'debugimageout',
]);

function json(status: number, value: unknown): Extract<RemoteAgentReply, { type: 'http' }> {
  return {
    type: 'http',
    status,
    headers: [['content-type', 'application/json']],
    body: Buffer.from(JSON.stringify(value)).toString('base64'),
  };
}

function errorStatus(code: string): number {
  switch (code) {
    case 'INVALID':
      return 400;
    case 'EACCES':
    case 'EPERM':
      return 403;
    case 'ENOENT':
    case 'ENOTDIR':
      return 404;
    case 'UNSUPPORTED':
      return 501;
    case 'CLOSED':
      return 410;
    default:
      return 500;
  }
}

export function mapRemoteMcpArguments(workspace: ExecutorWorkspace, value: unknown, key = ''): unknown {
  if (typeof value === 'string') {
    if (key === 'args') {
      try {
        const parsed = JSON.parse(value);
        if (parsed && typeof parsed === 'object') return JSON.stringify(mapRemoteMcpArguments(workspace, parsed));
      } catch { /* 普通字符串参数保持原样。 */ }
    }
    if (/^(?:cmd|command)$/.test(key)) return workspace.mapCommand(value, resolveExecutorShell().dialect);
    const fieldContext = pathTextContext(key);
    if (fieldContext === 'ambiguous-path') return workspace.mapTextFromAgent(value, fieldContext);
    if (fieldContext === 'path' || PATH_ARGUMENTS.has(key.replace(/_/g, '').toLowerCase())) return workspace.mapAlias(value);
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => mapRemoteMcpArguments(workspace, item, key));
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mapRemoteMcpArguments(workspace, item, name)]));
}

export function createReverseHttpRouter(deps: ReverseHttpRouterDeps) {
  const doFetch = deps.fetch ?? fetch;
  const workspace = deps.executor.workspace;

  const mapArguments = (value: unknown) => mapRemoteMcpArguments(workspace, value);
  const projectResult = (value: unknown, key = ''): unknown => {
    if (typeof value === 'string') {
      if (value.startsWith('file://')) {
        try {
          const uri = new URL(value);
          const virtual = workspace.toAgentPath(fileURLToPath(uri));
          if (virtual !== fileURLToPath(uri)) {
            uri.host = '';
            uri.pathname = virtual.replace(/\\/g, '/');
            return uri.href;
          }
        } catch { /* 普通字符串或非本机 file URL，交给文本投影。 */ }
      }
      return workspace.mapTextForAgent(value, pathTextContext(key));
    }
    if (Array.isArray(value)) return value.map((item) => projectResult(item, key));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, projectResult(item, name)]));
  };

  async function forwardMcp(
    target: LocalMcpTarget,
    method: string,
    headers: Array<[string, string]>,
    body: Buffer | undefined,
    signal?: AbortSignal,
    localArguments = false,
  ): Promise<RemoteAgentReply> {
    // 推送流(GET)对请求-响应式隧道没有意义，按协议回 405 让客户端不开推送流。
    if (method === 'GET') return { type: 'http', status: 405, headers: [['allow', 'POST, DELETE']] };
    const outgoing = new Headers(target.headers);
    for (const [name, value] of headers) {
      if (FORWARD_REQUEST_HEADERS.has(name.toLowerCase())) outgoing.set(name, value);
    }
    const response = await doFetch(target.url, {
      method,
      headers: outgoing,
      ...(body && method !== 'GET' && method !== 'HEAD' ? { body: new Uint8Array((() => {
        try {
          const message = JSON.parse(body.toString('utf8'));
          if (!localArguments && message.method === 'tools/call' && message.params?.arguments) {
            message.params.arguments = mapArguments(message.params.arguments);
          }
          return Buffer.from(JSON.stringify(message));
        } catch { return body; }
      })()) } : {}),
      signal,
    });
    let data = Buffer.from(await response.arrayBuffer());
    if (response.headers.get('content-type')?.includes('application/json')) {
      try { data = Buffer.from(JSON.stringify(projectResult(JSON.parse(data.toString('utf8'))))); } catch { /* 非 JSON 原样透传。 */ }
    } else if (response.headers.get('content-type')?.includes('text/event-stream')) {
      data = Buffer.from(data.toString('utf8').split('\n').map((line) => {
        if (!line.startsWith('data:')) return line;
        try { return 'data: ' + JSON.stringify(projectResult(JSON.parse(line.slice(5).trim()))); } catch { return line; }
      }).join('\n'));
    }
    const replyHeaders: Array<[string, string]> = [];
    response.headers.forEach((value, name) => {
      if (FORWARD_RESPONSE_HEADERS.has(name.toLowerCase())) replyHeaders.push([name, value]);
    });
    return {
      type: 'http',
      status: response.status,
      headers: replyHeaders,
      ...(data.length ? { body: data.toString('base64') } : {}),
    };
  }

  return async function route(
    request: { method: string; path: string; headers: Array<[string, string]>; body?: string },
    signal?: AbortSignal,
  ): Promise<RemoteAgentReply> {
    const url = new URL(request.path, 'http://tunnel.invalid');
    if (deps.hostToolsOnly && (!/^\/mcp\/[A-Za-z0-9_-]{1,64}$/.test(url.pathname) || url.pathname === `/mcp/${CINDY_EXEC_MCP_SERVER}`)) {
      return json(403, { error: { code: 'EACCES', message: 'Only application tools are available in this session.' } });
    }
    const body = request.body ? Buffer.from(request.body, 'base64') : undefined;
    const execMatch = /^\/exec\/([a-z]+\.[a-z]+)$/.exec(url.pathname);
    if (execMatch) {
      if (deps.approve) return json(403, { error: { code: 'EACCES', message: 'Shared Claude execution must use the approved MCP tool path.' } });
      if (request.method !== 'POST') return json(405, { error: { code: 'INVALID', message: 'POST only' } });
      let parsed: unknown;
      try {
        parsed = JSON.parse(body?.toString('utf8') ?? '{}');
      } catch {
        return json(400, { error: { code: 'INVALID', message: 'invalid JSON body' } });
      }
      try {
        return json(200, await deps.executor.handle(execMatch[1], parsed, signal));
      } catch (error) {
        const code = error instanceof ExecutorRequestError ? error.code : 'EXECUTOR_ERROR';
        const message = error instanceof Error ? error.message : String(error);
        return json(errorStatus(code), { error: { code, message } });
      }
    }
    const mcpMatch = /^\/mcp\/([A-Za-z0-9_-]{1,64})$/.exec(url.pathname);
    if (mcpMatch) {
      const name = mcpMatch[1];
      const dispatch = async (requestBody: Buffer | undefined, localArguments = false): Promise<RemoteAgentReply> => {
        if (name === CINDY_EXEC_MCP_SERVER) {
          const response = await handleExecMcpRequest(deps.executor, request.method, requestBody, signal, localArguments);
          return { type: 'http', status: response.status, headers: response.headers,
            ...(response.body?.length ? { body: response.body.toString('base64') } : {}) };
        }
        const target = deps.mcpTarget(name);
        if (!target) return json(404, { error: { code: 'NOT_FOUND', message: `MCP server ${name} is not available for this task` } });
        return forwardMcp(target, request.method, request.headers, requestBody, signal, localArguments);
      };
      if (!deps.approve || request.method !== 'POST') return dispatch(body);
      let message: Record<string, unknown>;
      try { message = JSON.parse(body?.toString('utf8') ?? '{}'); }
      catch { return json(400, { error: { code: 'INVALID', message: 'Invalid MCP request.' } }); }
      if (Array.isArray(message)) {
        if (!message.length || message.length > 32) return json(400, { error: { code: 'INVALID', message: 'Invalid MCP batch.' } });
        const responses = await Promise.all(message.map(async item => {
          const response = await route({ ...request, body: Buffer.from(JSON.stringify(item)).toString('base64') }, signal);
          if (response.type !== 'http' || !response.body) return null;
          const text = Buffer.from(response.body, 'base64').toString('utf8');
          try { return JSON.parse(text); } catch { /* Streamable HTTP may return SSE. */ }
          for (const line of text.split('\n')) {
            if (!line.startsWith('data:')) continue;
            try {
              const value = JSON.parse(line.slice(5));
              if (value.id === item?.id && ('result' in value || 'error' in value)) return value;
            } catch { /* Ignore non-result SSE frames. */ }
          }
          return { jsonrpc: '2.0', id: item?.id ?? null, error: { code: -32603, message: 'Result unavailable; check the outcome before repeating this operation.' } };
        }));
        return json(200, responses.filter(value => value !== null));
      }
      if (!message || typeof message !== 'object') return json(400, { error: { code: 'INVALID', message: 'Invalid MCP request.' } });
      if (message.method !== 'tools/call' && message.method !== 'resources/read') return dispatch(body);
      const params = message.params as { name?: unknown; arguments?: unknown } | undefined;
      const toolName = message.method === 'resources/read' ? 'resources/read' : params?.name;
      if (typeof toolName !== 'string' || !toolName || (typeof message.id !== 'string' && typeof message.id !== 'number')) {
        return json(400, { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: 'Tool execution requires a valid request.' } });
      }
      const args = message.method === 'resources/read' ? message.params ?? {} : params?.arguments ?? {};
      if (!args || typeof args !== 'object' || Array.isArray(args)) return json(400, { error: { code: 'INVALID', message: 'Tool arguments must be an object.' } });
      try {
        return await deps.approve(`mcp__${name}__${toolName}`, args as Record<string, unknown>, async approved => {
          const next = { ...message, params: message.method === 'resources/read' ? approved : { ...params, arguments: approved } };
          return dispatch(Buffer.from(JSON.stringify(next)), true);
        }, signal);
      } catch (error) {
        const reason = workspace.mapTextForAgent(error instanceof Error && error.name === 'ToolPermissionDenied' ? error.message : 'Tool approval could not be completed.');
        return json(200, message.method === 'tools/call'
          ? { jsonrpc: '2.0', id: message.id, result: { isError: true, content: [{ type: 'text', text: reason }] } }
          : { jsonrpc: '2.0', id: message.id, error: { code: -32000, message: reason } });
      }
    }
    return json(404, { error: { code: 'NOT_FOUND', message: 'unknown path' } });
  };
}
