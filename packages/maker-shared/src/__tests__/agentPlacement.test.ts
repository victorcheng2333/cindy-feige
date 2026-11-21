/**
 * Tier: unit.
 * Production entry: `@cindy/maker-shared/agent-placement`, used by the Desktop switch
 * handler and the Mobile picker. Regression (2026-11-21): a local task whose Claude
 * Agent borrowed another computer's source could not switch to Agy, because callers
 * treated the Agent runtime device as the task's location.
 */
import { describe, expect, it } from 'vitest';
import {
  TASK_COMPUTER_ONLY_AGENT_KINDS,
  canHandOffToTaskComputerOnlyEngine,
  runsOnTaskComputerOnly,
} from '../agentPlacement.js';

describe('agent placement', () => {
  it('lists the engines that only run on the task computer', () => {
    expect(TASK_COMPUTER_ONLY_AGENT_KINDS).toEqual(['cursor']);
    expect(runsOnTaskComputerOnly('cursor')).toBe(true);
    expect(runsOnTaskComputerOnly('antigravity')).toBe(false);
    expect(runsOnTaskComputerOnly('claude-code')).toBe(false);
  });

  it('decides from the task location, never from a borrowed Agent runtime device', () => {
    const task = { remoteHostId: null, orcaRole: null, orcaRemoteLead: null, source: 'desktop' };
    expect(canHandOffToTaskComputerOnlyEngine({ ...task, agentDeviceId: 'shared-mac' } as typeof task)).toBe(true);
    expect(canHandOffToTaskComputerOnlyEngine({ ...task, remoteHostId: 'ssh-host' })).toBe(false);
    expect(canHandOffToTaskComputerOnlyEngine({ ...task, orcaRole: 'lead' })).toBe(false);
    expect(canHandOffToTaskComputerOnlyEngine({ ...task, source: 'review' })).toBe(false);
  });
});
