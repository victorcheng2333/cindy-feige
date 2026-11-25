// @vitest-environment jsdom
//
// Codex 子代理卡与 Claude 子代理卡的形态一致性回归。
//
// Cindy 的子代理 UI 只有一张卡(AgentTaskCard):Claude 靠 SDK 的 task_progress 驱动,
// Codex 此前没有数据源、只能渲染一句「已启动」就地收口。补上子线程实时事件后,两者必须
// 长得一样 —— 同样的 provider·状态·tokens·工具调用数·耗时,且 codex 不多出冗余文案。

import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, vars?: Record<string, unknown>) =>
      vars && Object.keys(vars).length > 0 ? `${key}:${JSON.stringify(vars)}` : key,
  }),
}));

vi.mock('@/hooks/useExpandedBlockMemory', () => ({
  useExpandedBlockMemory: () => ({ expanded: false, setExpanded: vi.fn() }),
}));

vi.mock('@/lib/makerTransport', () => ({
  getWorkflowProgressFor: vi.fn(async () => null),
  isRemoteSessionSticky: () => false,
}));
vi.mock('@/lib/backgroundTaskStop', () => ({
  canManageBackgroundTasks: () => true,
  stopBackgroundTask: vi.fn(async () => {}),
}));

vi.mock('@/features/right-sidebar/lib/openBackgroundTasksTab', () => ({
  openBackgroundTasksTab: vi.fn(),
}));

vi.mock('@/features/right-sidebar/plugins/background-tasks/listSessionTasks', () => ({
  extractWorkflowTaskId: () => undefined,
}));

vi.mock('@/features/right-sidebar/plugins/background-tasks/WorkflowAgentStrip', () => ({
  WorkflowAgentStrip: () => null,
}));

vi.mock('@/features/cc-agent/embeddedSessionNavigation', () => ({
  useSidebarPanelReachable: () => false,
}));

vi.mock('@/components/ui/collapse', () => ({
  Collapse: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

vi.mock('@/lib/modelShortLabel', () => ({
  formatModelShortLabel: (model?: string | null) => model ?? undefined,
}));

import { AgentTaskCard } from '../AgentTaskCard';
import type { AgentTaskUpdate, ChatMessage } from '@/hooks/useCCAgentChat';

function spawnToolCall(): ChatMessage {
  return {
    clientId: 'c1',
    role: 'tool_use',
    content: '',
    toolUseId: 'spawn-1',
    toolName: 'collab:spawn',
    toolInput: { name: '/root/scout', agentThreadId: 't-2' },
  } as unknown as ChatMessage;
}

const liveCodexUpdate: AgentTaskUpdate = {
  provider: 'codex',
  taskId: 'spawn-1',
  parentToolUseId: 'spawn-1',
  status: 'running',
  title: '/root/scout',
  usage: { totalTokens: 143615, toolUses: 25, durationMs: 170_000 },
};

describe('AgentTaskCard codex subagent live state', () => {
  it('shows the same meta row as a claude subagent card', () => {
    const { container } = render(
      <AgentTaskCard toolCall={spawnToolCall()} result="/root/scout" update={liveCodexUpdate} />,
    );
    const text = container.textContent ?? '';

    expect(text).toContain('chat.agentTask.provider.codex');
    expect(text).toContain('chat.agentTask.status.running');
    // tokens / 工具调用数 / 耗时三项都由 update.usage 驱动,与 Claude 卡同一渲染路径。
    expect(text).toContain('chat.agentTask.tokens:{"count":"143.6k"}');
    expect(text).toContain('chat.agentTask.toolUses');
    expect(text).toContain('2m 50s');
  });

  it('drops the "已启动" receipt once live state exists, and never leaks the raw agent path as summary', () => {
    const { container } = render(
      <AgentTaskCard toolCall={spawnToolCall()} result="/root/scout" update={liveCodexUpdate} />,
    );
    const text = container.textContent ?? '';

    // 冗余文案:title 与运行状态已经表达了「已启动」,Claude 卡在运行中也没有这行。
    expect(text).not.toContain('chat.agentTask.subagentStarted');
    expect(text).not.toContain('/root/');
    expect(text).toContain('scout');
    expect(text).toContain('rightSidebar.tabs.kinds.subagents');
  });

  it('keeps the localized receipt for history replay (no live update)', () => {
    // 历史回放拿不到 live update(agent_task_update 不落库),回执是唯一可读摘要。
    const { container } = render(<AgentTaskCard toolCall={spawnToolCall()} result="/root/scout" />);
    expect(container.textContent ?? '').toContain('chat.agentTask.subagentStarted');
    expect(container.textContent ?? '').not.toContain('/root/');
  });

  it('renders terminal codex subagent state instead of staying stuck on running', () => {
    const { container } = render(
      <AgentTaskCard
        toolCall={spawnToolCall()}
        result="/root/scout"
        update={{ ...liveCodexUpdate, status: 'completed' }}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('chat.agentTask.status.completed');
    expect(text).not.toContain('chat.agentTask.status.running');
  });

  // Tier: unit. Production entry: `AgentTaskCard` with Antigravity `Run invoke_subagent`.
  // Gap: Agy `invoke_subagent` immediately settles with a `{ conversationId }` launch receipt;
  // the card must stay running, extract `Role` as title, suppress raw JSON receipt, and surface live usage.
  it('renders Antigravity invoke_subagent launch receipts as running live cards without leaking raw receipt JSON', () => {
    const agyToolCall = {
      clientId: 'c-agy',
      role: 'tool_use',
      content: '',
      toolUseId: 'call-agy-1',
      toolName: 'Run invoke_subagent',
      toolInput: { TypeName: 'research', Role: 'Independent Diff Reviewer', Prompt: 'Review changes' },
    } as unknown as ChatMessage;
    const receipt = 'Created the following subagent:\n{"conversationId":"sub-conv-42"}';
    const liveAgyUpdate: AgentTaskUpdate = {
      provider: 'antigravity',
      taskId: 'sub-conv-42',
      parentToolUseId: 'call-agy-1',
      status: 'running',
      title: 'Independent Diff Reviewer',
      model: 'gemini-4-neon-xhigh',
      lastToolName: 'read_file',
      summary: 'Inspecting session.ts',
      usage: { totalTokens: 48_200, toolUses: 9 },
    };
    const { container } = render(
      <AgentTaskCard
        toolCall={agyToolCall}
        result={receipt}
        update={liveAgyUpdate}
        sessionId="s-agy"
        sessionAgentKind="antigravity"
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Antigravity');
    expect(text).toContain('Independent Diff Reviewer');
    expect(text).toContain('chat.agentTask.status.running');
    expect(text).toContain('gemini-4-neon-xhigh');
    expect(text).toContain('Inspecting session.ts');
    expect(text).not.toContain('Created the following subagent');
    expect(text).not.toContain('sub-conv-42');
  });
});
