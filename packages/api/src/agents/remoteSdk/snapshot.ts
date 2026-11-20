import { z } from 'zod';
import type { RemoteSdkSnapshot, RemoteSdkLimits } from './types';
import { encodeSdkValue, decodeSdkValue } from './wire';

/** One bounded transfer per execution; chunks precede the terminal receipt in the ordered durable stream. */
export function createSnapshotReceiver(maxBytes: number) {
  let buffer: Buffer | undefined;
  let received = 0;
  let total: number | undefined;
  let finished = false;
  return {
    accept(data: unknown): null {
      const chunk = z
        .object({
          offset: z.number().int().nonnegative(),
          total: z.number().int().positive().max(maxBytes),
          data: z
            .string()
            .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
        })
        .parse(data);
      const bytes = Buffer.from(chunk.data, 'base64');
      if (
        finished ||
        !bytes.length ||
        chunk.offset !== received ||
        (total !== undefined && total !== chunk.total) ||
        received + bytes.length > chunk.total
      )
        throw new Error('Invalid SDK snapshot transfer');
      total = chunk.total;
      buffer ??= Buffer.alloc(chunk.total);
      bytes.copy(buffer, received);
      received += bytes.length;
      return null;
    },
    finish(data: unknown): RemoteSdkSnapshot {
      const receipt = z
        .object({ snapshotBytes: z.number().int().positive().max(maxBytes) })
        .parse(data);
      if (finished || received !== total || receipt.snapshotBytes !== total)
        throw new Error('Incomplete SDK snapshot transfer');
      finished = true;
      const snapshot = decodeSdkValue(JSON.parse(buffer!.toString('utf8'))) as RemoteSdkSnapshot;
      buffer = undefined;
      return snapshot;
    },
  };
}

export async function sendSnapshot(
  peer: { send: (frame: { type: 'snapshot' | 'done'; data: unknown }) => void },
  snapshot: RemoteSdkSnapshot,
  limits: RemoteSdkLimits,
  flush?: () => Promise<void>,
): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(encodeSdkValue(snapshot)));
  if (bytes.length > limits.maxBufferedBytes) throw new Error('SDK snapshot capacity exceeded');
  // Leave room for base64 expansion, RPC identity and the wire value tags.
  const chunkBytes = Math.max(1, Math.floor(limits.maxFrameBytes / 4));
  for (let offset = 0; offset < bytes.length; offset += chunkBytes) {
    peer.send({
      type: 'snapshot',
      data: {
        offset,
        total: bytes.length,
        data: bytes.subarray(offset, offset + chunkBytes).toString('base64'),
      },
    });
    await flush?.();
  }
  peer.send({
    type: 'done',
    data: { snapshotBytes: bytes.length, interrupt: snapshot.interrupt == null ? undefined : true },
  });
}
