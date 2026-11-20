import { mountPage } from '../../ui-page/harness';
import { TodaySpendChip } from '../../../src/renderer/components/status/TodaySpendChip';

let localReads = 0;
let remoteReads = 0;
void mountPage({
  host: ctx => {
    const read = async () => {
      await new Promise<void>(resolve => {
        document.addEventListener('fixture:release-agy-quota', () => resolve(), { once: true });
      });
      const now = Date.now();
      const snapshot = ctx.case === 'agy-quota-unavailable' ? null : {
        fetchedAtMs: now,
        windows: [
          { group: 'Gemini Pro', minutes: 300, remaining: 76, resetsAtMs: now + 7200000 },
          { group: 'Gemini Pro', minutes: 10080, remaining: 0, resetsAtMs: now + 86400000 },
        ],
      };
      return { providerId: 'antigravity', connected: !!snapshot, status: snapshot ? 'ready' : 'unavailable', snapshot };
    };
    return {
      maker: { usage: {
        getAntigravitySubscription: async () => {
          document.documentElement.dataset.localAgyReads = String(++localReads);
          return read();
        },
      } },
      deviceLink: {
        invoke: async (device: string, channel: string, args: unknown[]) => {
          if (device !== 'task-computer' || channel !== 'maker:usage:antigravity-subscription' || args.length) {
            throw new Error('Unexpected Agy quota route');
          }
          document.documentElement.dataset.remoteAgyReads = String(++remoteReads);
          return read();
        },
      },
    };
  },
  render: ctx => (
    <main className="flex h-screen items-end justify-end bg-content-area p-4">
      <TodaySpendChip vendorKey="antigravity" providerId="antigravity" sessionId="fixture"
        deviceLinkDeviceId={ctx.case === 'agy-quota-remote' ? 'task-computer' : undefined} />
    </main>
  ),
});
