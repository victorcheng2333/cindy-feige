/**
 * Where a task lives versus where its Agent runs. Read
 * `docs/dev-rules/agent-placement.md` before changing which engines a task may use.
 *
 * - Task computer: the computer that owns the task row, project files and commands.
 *   An SSH task (`remoteHostId`) lives on that SSH host instead.
 * - Agent runtime device (`agentDeviceId`): another same-account computer, or a shared
 *   provider, that currently runs the task's Claude Code / Codex / Pi Agent. The task
 *   itself stays on the task computer. This is NOT the task's location.
 * - Controlled computer (Desktop `deviceLinkDeviceId`, Mobile target device): the computer
 *   a controller is operating. Its own tasks live there.
 *
 * Engines in TASK_COMPUTER_ONLY_AGENT_KINDS can only run on the task computer (local CLI,
 * subscription and process control). A borrowed Agent runtime device never blocks them:
 * switching moves the Agent home and the destination `agentDeviceId` becomes null.
 */
export const TASK_COMPUTER_ONLY_AGENT_KINDS = [] as const;

export type TaskComputerOnlyAgentKind = (typeof TASK_COMPUTER_ONLY_AGENT_KINDS)[number];

export function runsOnTaskComputerOnly(agentKind: unknown): agentKind is TaskComputerOnlyAgentKind {
  return (TASK_COMPUTER_ONLY_AGENT_KINDS as readonly unknown[]).includes(agentKind);
}

/**
 * Whether an existing task may hand off to a task-computer-only engine. Only the task's
 * own location and role decide: SSH tasks, Orca roles, remote Worker/Lead links and tasks
 * created outside Desktop (review, IM, ...) cannot. `agentDeviceId` is deliberately not
 * an input; callers must not add it back.
 */
export function canHandOffToTaskComputerOnlyEngine(task: {
  remoteHostId?: string | null;
  orcaRole?: string | null;
  orcaRemoteLead?: unknown;
  source?: string | null;
}): boolean {
  return !task.remoteHostId && !task.orcaRole && !task.orcaRemoteLead
    && (!task.source || task.source === 'desktop');
}
