import { describe, expect, it } from 'vitest';
import { sharedTaskHostPeer } from '@cindy/device-link';
import { isOwnUserBubble } from '../userBubbleOwnership';

const ownerDevice = 'mac-owner-device';
const guestView = sharedTaskHostPeer('shared-task-1', ownerDevice);

describe('desktop my message bubble ownership', () => {
  it('tints only my messages when I own the task', () => {
    expect(isOwnUserBubble({}, { accountId: 'owner', remoteDeviceId: ownerDevice })).toBe(true);
    expect(isOwnUserBubble(
      { sharedAuthorName: 'Guest', sharedAuthorAccountId: 'guest' },
      { accountId: 'owner', remoteDeviceId: ownerDevice },
    )).toBe(false);
  });

  it('tints only my messages when I join as a guest', () => {
    expect(isOwnUserBubble({}, { accountId: 'guest', remoteDeviceId: guestView })).toBe(false);
    expect(isOwnUserBubble(
      { sharedAuthorName: 'Me', sharedAuthorAccountId: 'guest' },
      { accountId: 'guest', remoteDeviceId: guestView },
    )).toBe(true);
  });
});
