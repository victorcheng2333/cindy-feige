import { parseMessageToolUse } from '@cindy/maker-shared/message-normalize';
import type { AgentEvent, UsageSnapshot } from '../../types/events.js';

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

const toolNames: Readonly<Record<string, string>> = {
  run_command: 'Bash',
  read_file: 'Read',
  view_file: 'Read',
  write_file: 'Write',
  write_to_file: 'Write',
  replace_file_content: 'Edit',
  list_directory: 'LS',
  find_by_name: 'Glob',
  grep_search: 'Grep',
};

export class AgyTurn {
  private text = '';
  private sawText = false;
  private readonly tools = new Map<number, { id: string; finished: boolean }>();

  constructor(
    private readonly emit: (type: AgentEvent['type'], data: unknown) => void,
    private readonly usage: UsageSnapshot,
  ) {
    this.emit('status', { ...usage, status: 'Working…', isRunning: true });
  }

  private flush() {
    if (!this.text) return;
    this.emit('text', { text: this.text, isFinal: true, isFullText: true });
    this.text = '';
  }

  step(step: Record<string, unknown>) {
    if (step.step_type === 'agent_response') {
      if (typeof step.text_delta === 'string' && step.text_delta) {
        this.text += step.text_delta;
        this.sawText = true;
        this.emit('text', { text: step.text_delta, isFinal: false });
      }
      if (step.state === 'DONE') this.flush();
      return;
    }
    if (step.step_type !== 'tool' || typeof step.step_index !== 'number') return;
    const info = record(step.tool_info);
    const name = typeof step.tool_name === 'string' ? step.tool_name : info.name;
    if (typeof name !== 'string') return;

    this.flush();
    let tool = this.tools.get(step.step_index);
    if (!tool) {
      const id = `agy:${String(step.conversation_id)}:${step.step_index}`;
      tool = { id, finished: false };
      this.tools.set(step.step_index, tool);
      const args = record(info.parameters);
      const input = { ...args };
      if (name === 'run_command') input.command = args.CommandLine;
      if ('FilePath' in args || 'TargetFile' in args) input.file_path = args.FilePath ?? args.TargetFile;
      const toolName = name === 'call_mcp_tool' && typeof args.ServerName === 'string' && typeof args.ToolName === 'string'
        ? `mcp__${args.ServerName}__${args.ToolName}`
        : (Object.hasOwn(toolNames, name) ? toolNames[name] : name);
      this.emit('tool_use', {
        toolUseId: id,
        ...parseMessageToolUse({ role: 'tool_use', content: { toolName, input }, toolUseId: id }),
      });
    }
    if (!tool.finished && (step.state === 'DONE' || step.state === 'ERROR')) {
      tool.finished = true;
      const error = record(info.error).message;
      const output = typeof error === 'string' ? error : info.output;
      this.toolResult(tool.id, typeof output === 'string' ? output : '', step.state === 'ERROR' || !!info.error);
    }
  }

  private toolResult(toolUseId: string, fullText: string, isError: boolean) {
    this.emit('tool_result_full', { toolUseId, fullText, isError });
    this.emit('tool_result', { summary: isError ? 'failed' : 'done', toolUseIds: [toolUseId] });
  }

  finish(outcome: 'success' | 'stopped' | 'error', result: Record<string, unknown> = {}) {
    this.flush();
    for (const tool of this.tools.values()) {
      if (!tool.finished) this.toolResult(tool.id, outcome === 'stopped' ? 'Stopped.' : 'agy did not report completion.', true);
    }
    if (!this.sawText && typeof result.response === 'string' && result.response) {
      this.emit('text', { text: result.response, isFinal: true, isFullText: true });
    }
    const counts = record(result.usage);
    const count = (key: string) => {
      const value = counts[key];
      return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
    };
    this.usage.tokenUsage = count('total_tokens');
    this.usage.outputTokens = count('output_tokens');
    if (outcome === 'error') {
      this.emit('error', {
        message: result.message ?? 'agy could not complete this turn. Check your CLI login, model, and network.',
        isTerminal: true,
      });
    } else {
      this.emit('done', {
        type: 'antigravity/turn-ended',
        status: outcome === 'stopped' ? 'stopped' : 'completed',
        result: typeof result.response === 'string' ? result.response : undefined,
      });
    }
    this.emit('status', { ...this.usage, status: 'Done', isRunning: false });
  }
}
