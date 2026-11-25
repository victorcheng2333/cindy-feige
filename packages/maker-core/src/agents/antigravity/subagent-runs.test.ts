// Tier: unit. Production entries: `createAntigravitySubagentRunsReader`, `listAntigravitySubagentRuns`,
// `readAntigravitySubagentTranscriptPage`.
// Gap: Agy persists detached subagents under `brain/<parent>/.system_generated/{subagents,messages}` and
// `brain/<child>/.system_generated/logs/transcript.jsonl` without streaming child updates over ACP.
// Minimal failing inputs: incremental transcript append, inbox completion report, system stop notice
// leaving state ALIVE, multi-tool FIFO pairing across page/tail cursors, and symlinked transcript rejection.
import { mkdir, mkdtemp, rm, symlink, writeFile, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createAntigravitySubagentRunsReader,
  listAntigravitySubagentRuns,
  readAntigravitySubagentTranscriptPage,
} from './subagent-runs.js';

async function setupAgyFixture() {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-agy-subagents-'));
  const cliDir = path.join(stateDir, 'antigravity-cli');
  const parentId = 'parent-conv-1';
  const childId = 'child-conv-1';
  const parentSys = path.join(cliDir, 'brain', parentId, '.system_generated');
  const childLogs = path.join(cliDir, 'brain', childId, '.system_generated', 'logs');
  await mkdir(path.join(parentSys, 'subagents'), { recursive: true });
  await mkdir(path.join(parentSys, 'messages'), { recursive: true });
  await mkdir(childLogs, { recursive: true });
  return {
    stateDir,
    parentId,
    childId,
    subagentsDir: path.join(parentSys, 'subagents'),
    messagesDir: path.join(parentSys, 'messages'),
    childTranscript: path.join(childLogs, 'transcript.jsonl'),
    cleanup: () => rm(stateDir, { recursive: true, force: true }),
  };
}

describe('Antigravity subagent progress and paginated transcript reader', () => {
  it('incrementally tails child transcripts, resolves completion reports, and handles system stop notices', async () => {
    const fx = await setupAgyFixture();
    try {
      await writeFile(
        path.join(fx.subagentsDir, `${fx.childId}.json`),
        JSON.stringify({
          conversationId: fx.childId,
          subagentDescriptor: { typeName: 'research', role: 'Independent Diff Reviewer' },
          state: 'SUBAGENT_STATE_ALIVE',
        }),
      );
      await writeFile(
        fx.childTranscript,
        [
          JSON.stringify({
            step_index: 0,
            source: 'SYSTEM',
            type: 'SYSTEM_MESSAGE',
            created_at: '2026-11-25T06:00:00Z',
            content:
              'The following is a <SYSTEM_MESSAGE>\n\n<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-25T06:00:00Z sender=parent-conv-1 priority=MESSAGE_PRIORITY_HIGH content=Review the diff carefully.\n</SYSTEM_MESSAGE>',
          }),
          JSON.stringify({
            step_index: 1,
            source: 'MODEL',
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-25T06:00:05Z',
            model: 'gemini-4-neon-xhigh',
            input_tokens: 1000,
            cache_read_tokens: 500,
            output_tokens: 200,
            thinking: 'Inspecting session.ts for race conditions.\nChecking fallback paths next.',
            tool_calls: [
              {
                name: 'run_command',
                args: { CommandLine: '"git diff"', toolSummary: '"Inspect git diff"' },
              },
            ],
          }),
        ].join('\n') + '\n',
      );

      const reader = createAntigravitySubagentRunsReader(fx.stateDir);
      const first = await reader.readRuns(fx.parentId);
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({
        childId: fx.childId,
        role: 'Independent Diff Reviewer',
        typeName: 'research',
        prompt: 'Review the diff carefully.',
        status: 'running',
        model: 'gemini-4-neon-xhigh',
        totalTokens: 1700,
        toolUses: 1,
        lastToolName: 'run_command',
        summary: 'Inspecting session.ts for race conditions.',
      });

      // Append a second step and verify incremental byte-tailing adds without double-counting.
      await appendFile(
        fx.childTranscript,
        JSON.stringify({
          step_index: 2,
          source: 'MODEL',
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-25T06:00:15Z',
          model: 'gemini-4-neon-xhigh',
          input_tokens: 300,
          cache_read_tokens: 0,
          output_tokens: 100,
          tool_calls: [{ name: 'read_file', args: { Path: '"/repo/a.ts"', StartLine: '1' } }],
        }) + '\n',
      );
      const second = await reader.readRuns(fx.parentId);
      expect(second[0]).toMatchObject({
        status: 'running',
        totalTokens: 2100,
        toolUses: 2,
        lastToolName: 'read_file',
      });

      // System stop notice newer than last activity marks ALIVE child as stopped.
      await writeFile(
        path.join(fx.messagesDir, 'sys-stop.json'),
        JSON.stringify({
          sender: 'system',
          timestamp: '2026-11-25T06:01:00Z',
          content: '[Notice] All your subagents and background tasks have been stopped due to user force cancellation.',
        }),
      );
      const stopped = await reader.readRuns(fx.parentId);
      expect(stopped[0]?.status).toBe('stopped');

      // Completion message from the child resolves completed + returnedResult.
      await writeFile(
        path.join(fx.messagesDir, 'reply-1.json'),
        JSON.stringify({
          sender: fx.childId,
          timestamp: '2026-11-25T06:02:00Z',
          content: 'NO P0/P1 FINDINGS',
        }),
      );
      const completed = await reader.readRuns(fx.parentId);
      expect(completed[0]).toMatchObject({
        status: 'completed',
        summary: 'NO P0/P1 FINDINGS',
        returnedResult: 'NO P0/P1 FINDINGS',
      });

      // A newer parent follow-up inside the child transcript revives it to running.
      await appendFile(
        fx.childTranscript,
        JSON.stringify({
          step_index: 3,
          source: 'SYSTEM',
          type: 'SYSTEM_MESSAGE',
          created_at: '2026-11-25T06:03:00Z',
          content:
            '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-25T06:03:00Z sender=parent-conv-1 priority=MESSAGE_PRIORITY_HIGH content=Also check tests.\n</SYSTEM_MESSAGE>',
        }) + '\n',
      );
      const revived = await reader.readRuns(fx.parentId);
      expect(revived[0]?.status).toBe('running');
    } finally {
      await fx.cleanup();
    }
  });

  it('paginates transcripts with FIFO tool pairing across pages and live tailCursor appends, and rejects symlinks', async () => {
    const fx = await setupAgyFixture();
    try {
      await writeFile(
        fx.childTranscript,
        [
          JSON.stringify({
            step_index: 0,
            type: 'SYSTEM_MESSAGE',
            created_at: '2026-11-25T06:00:00Z',
            content:
              '<SYSTEM_MESSAGE>\n[Message] timestamp=2026-11-25T06:00:00Z sender=parent-conv-1 content=Audit auth.ts\n</SYSTEM_MESSAGE>',
          }),
          JSON.stringify({
            step_index: 1,
            type: 'PLANNER_RESPONSE',
            created_at: '2026-11-25T06:00:02Z',
            thinking: 'Reading auth.ts and checking tests.',
            tool_calls: [
              { name: 'read_file', args: { Path: '"/repo/auth.ts"', StartLine: '1', EndLine: '80' } },
              { name: 'run_command', args: { CommandLine: '"pnpm test"', toolSummary: '"Run auth tests"' } },
            ],
          }),
          JSON.stringify({
            step_index: 2,
            type: 'GENERIC',
            created_at: '2026-11-25T06:00:04Z',
            content: 'Created At: 2026-11-25\nCompleted At: 2026-11-25\n1: export const ok = true;',
          }),
          JSON.stringify({
            step_index: 3,
            type: 'GENERIC',
            created_at: '2026-11-25T06:00:06Z',
            content: 'Created At: 2026-11-25\nCompleted At: 2026-11-25\nCommand exited with code 1.\nTest failed',
          }),
        ].join('\n') + '\n',
      );

      // Page 1 stops right after PLANNER_RESPONSE (limit 2 -> parent + thinking + 2 tools = 4 entries).
      const page1 = await readAntigravitySubagentTranscriptPage(fx.stateDir, fx.childId, { limit: 2 });
      expect(page1.supported).toBe(true);
      expect(page1.nextCursor).toBeTruthy();
      expect(page1.entries.map((e) => [e.role, e.toolPhase, e.toolName])).toEqual([
        ['parent', undefined, undefined],
        ['thinking', undefined, undefined],
        ['tool', 'start', 'read_file'],
        ['tool', 'start', 'run_command'],
      ]);
      expect(page1.entries[0]?.content).toBe('Audit auth.ts');
      expect(page1.entries[2]?.content).toBe('read_file(/repo/auth.ts:1-80)');
      expect(page1.entries[3]?.content).toBe('run_command(Run auth tests)');
      const readCallId = page1.entries[2]?.toolCallId;
      const cmdCallId = page1.entries[3]?.toolCallId;

      // Page 2 pairs the two GENERIC results in FIFO order using cursor-carried pending queue.
      const page2 = await readAntigravitySubagentTranscriptPage(fx.stateDir, fx.childId, {
        cursor: page1.nextCursor,
        limit: 10,
      });
      expect(page2.nextCursor).toBeUndefined();
      expect(page2.tailCursor).toBeTruthy();
      expect(page2.entries).toMatchObject([
        { role: 'tool', toolPhase: 'end', toolCallId: readCallId, toolName: 'read_file', isError: false, content: '1: export const ok = true;' },
        { role: 'tool', toolPhase: 'end', toolCallId: cmdCallId, toolName: 'run_command', isError: true, content: 'Command exited with code 1.\nTest failed' },
      ]);

      // Appending a final reply and reading from tailCursor returns only the new entry.
      await appendFile(
        fx.childTranscript,
        JSON.stringify({
          step_index: 4,
          type: 'PLANNER_RESPONSE',
          created_at: '2026-11-25T06:00:10Z',
          content: 'Found 1 failing auth test.',
        }) + '\n',
      );
      const tail = await readAntigravitySubagentTranscriptPage(fx.stateDir, fx.childId, {
        cursor: page2.tailCursor,
      });
      expect(tail.entries).toEqual([
        expect.objectContaining({ role: 'subagent', content: 'Found 1 failing auth test.' }),
      ]);

      // Symlinked transcript outside stateDir must fail closed.
      const externalFile = path.join(fx.stateDir, 'outside.jsonl');
      await writeFile(externalFile, '{"type":"PLANNER_RESPONSE","content":"leaked"}\n');
      const symlinkChild = 'child-symlink';
      const symlinkLogs = path.join(fx.stateDir, 'antigravity-cli', 'brain', symlinkChild, '.system_generated', 'logs');
      await mkdir(symlinkLogs, { recursive: true });
      await symlink(externalFile, path.join(symlinkLogs, 'transcript.jsonl'));
      expect(await readAntigravitySubagentTranscriptPage(fx.stateDir, symlinkChild)).toEqual({
        supported: false,
        entries: [],
      });
      expect(await listAntigravitySubagentRuns(fx.stateDir, '../escape')).toEqual([]);
    } finally {
      await fx.cleanup();
    }
  });
});
