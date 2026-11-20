import type { RemoteSdkSnapshot } from './types';
import { createSnapshotReceiver, sendSnapshot } from './snapshot';
import { remoteSdkLimits } from './types';

it('reassembles a large Unicode snapshot before accepting its terminal receipt', async () => {
  const receiver = createSnapshotReceiver(100000);
  const snapshot = {
    content: [{ type: 'text', text: '🙂'.repeat(10000) }],
    messages: [],
  } as unknown as RemoteSdkSnapshot;
  let result: RemoteSdkSnapshot | undefined;
  let chunks = 0;
  await sendSnapshot(
    {
      send: (frame) => {
        expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThan(1024);
        if (frame.type === 'snapshot') {
          chunks++;
          receiver.accept(frame.data);
        } else result = receiver.finish(frame.data);
      },
    },
    snapshot,
    remoteSdkLimits({ maxFrameBytes: 1024, maxBufferedBytes: 100000 }),
  );
  expect(chunks).toBeGreaterThan(1);
  expect(result).toEqual(snapshot);
  expect(() => receiver.finish({ snapshotBytes: 1 })).toThrow();
});

it('rejects incomplete, reordered, and oversized transfers', () => {
  const receiver = createSnapshotReceiver(100);
  expect(() => receiver.accept({ offset: 0, total: 101, data: 'YQ==' })).toThrow();
  expect(() => receiver.accept({ offset: 1, total: 2, data: 'YQ==' })).toThrow();
  receiver.accept({ offset: 0, total: 2, data: 'YQ==' });
  expect(() => receiver.accept({ offset: 0, total: 2, data: 'YQ==' })).toThrow();
  expect(() => receiver.finish({ snapshotBytes: 2 })).toThrow('Incomplete');
});
