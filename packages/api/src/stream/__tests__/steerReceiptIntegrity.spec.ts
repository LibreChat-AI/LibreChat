import type { SteerQueueItem, SteerReceipt } from '../interfaces/IJobStore';
import {
  GenerationJobManagerClass,
  TERMINAL_PUBLICATION_RECONNECT_ERROR,
} from '../GenerationJobManager';
import { InMemoryEventTransport } from '../implementations/InMemoryEventTransport';
import { registerChunkPublicationCapability } from '../internal/chunkPublication';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';
import { STEER_ENQUEUE_RECEIPT_FULL } from '../interfaces/IJobStore';
import { REDIS_ABORT_TERMINAL_GRACE_MS } from '../internal/timing';

type ReceiptEntry = { receipt: SteerReceipt; expiresAt: number };
type ReceiptMap = Map<string, ReceiptEntry>;

interface ReceiptCorruption {
  name: string;
  apply: (receipts: ReceiptMap, clientSteerId: string) => void;
}

const receiptCorruptions: ReceiptCorruption[] = [
  {
    name: 'missing',
    apply: (receipts, clientSteerId) => {
      receipts.delete(clientSteerId);
    },
  },
  {
    name: 'malformed',
    apply: (receipts, clientSteerId) => {
      receipts.set(clientSteerId, {
        receipt: 'not-a-receipt' as unknown as SteerReceipt,
        expiresAt: Number.POSITIVE_INFINITY,
      });
    },
  },
  {
    name: 'wrong-state',
    apply: (receipts, clientSteerId) => {
      const entry = receipts.get(clientSteerId);
      if (entry != null) {
        entry.receipt.state = entry.receipt.state === 'queued' ? 'claimed' : 'queued';
      }
    },
  },
  {
    name: 'wrong-generation',
    apply: (receipts, clientSteerId) => {
      const entry = receipts.get(clientSteerId);
      if (entry != null) {
        entry.receipt.generationCreatedAt += 1;
      }
    },
  },
];

function receiptMap(store: InMemoryJobStore, streamId: string): ReceiptMap {
  return (
    store as unknown as {
      steerReceipts: Map<string, ReceiptMap>;
    }
  ).steerReceipts.get(streamId)!;
}

async function enqueueReceiptSteer(
  store: InMemoryJobStore,
  streamId: string,
  suffix: string,
): Promise<{ item: SteerQueueItem; createdAt: number }> {
  const job = await store.createJob(streamId, 'receipt-user', streamId);
  const item: SteerQueueItem = {
    steerId: `steer-${suffix}`,
    clientSteerId: `client-${suffix}`,
    text: `instruction ${suffix}`,
    userId: 'receipt-user',
    createdAt: Date.now(),
  };
  const result = await store.enqueueSteerWithReceipt(
    streamId,
    item,
    {
      clientSteerId: item.clientSteerId!,
      fingerprint: `fingerprint-${suffix}`,
      userId: item.userId,
      generationCreatedAt: job.createdAt,
    },
    false,
    job.createdAt,
  );
  expect(result).toMatchObject({ state: 'queued', item });
  return { item, createdAt: job.createdAt };
}

describe('InMemoryJobStore steer receipt integrity', () => {
  test.each(['deleted', 'v1-replaced'] as const)(
    'replays an existing receipt after its accepting job is %s',
    async (lifecycle) => {
      const store = new InMemoryJobStore();
      const streamId = `receipt-replay-${lifecycle}`;
      try {
        const { item, createdAt } = await enqueueReceiptSteer(store, streamId, lifecycle);
        if (lifecycle === 'deleted') {
          await expect(store.deleteJob(streamId, createdAt)).resolves.toBe(true);
        } else {
          const replacement = await store.createJob(streamId, item.userId, streamId, undefined, {
            generationProtocolVersion: 1,
          });
          expect(replacement.createdAt).not.toBe(createdAt);
          await expect(store.peekSteers(streamId, replacement.createdAt)).resolves.toEqual([]);
        }

        await expect(store.getSteerReceipt(streamId, item.clientSteerId!)).resolves.toMatchObject({
          state: 'leftover',
          generationCreatedAt: createdAt,
          item,
        });
        await expect(
          store.enqueueSteerWithReceipt(
            streamId,
            { ...item, steerId: `duplicate-${lifecycle}` },
            {
              clientSteerId: item.clientSteerId!,
              fingerprint: `fingerprint-${lifecycle}`,
              userId: item.userId,
              generationCreatedAt: createdAt,
            },
            false,
            createdAt,
          ),
        ).resolves.toMatchObject({
          state: 'leftover',
          generationCreatedAt: createdAt,
          item,
        });
      } finally {
        await store.destroy();
      }
    },
  );

  test('refreshes a recovery lease past the stale-job horizon and keeps its receipt', async () => {
    const store = new InMemoryJobStore({ staleJobTimeout: 20 * 60 * 1000 });
    const streamId = 'receipt-recovery-lease-activity';
    const base = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
    try {
      const { item, createdAt } = await enqueueReceiptSteer(store, streamId, 'recovery-lease');
      await expect(store.closeAndDrainSteers(streamId, createdAt)).resolves.toEqual([item]);
      const recovery = await store.createJob(
        streamId,
        item.userId,
        streamId,
        undefined,
        {},
        item.steerId,
        undefined,
        undefined,
        undefined,
        {
          text: item.text,
          fileIds: (item.files ?? []).flatMap((file) => file.file_id ?? []).sort(),
          quotes: item.quotes ?? [],
        },
      );

      // Generation remains healthy beyond the one-time create lease. Activity
      // near its original horizon must move both parked source and receipt out.
      nowSpy.mockReturnValue(base + 24 * 60 * 1000);
      store.recordActivity(streamId, recovery.createdAt);
      nowSpy.mockReturnValue(base + 30 * 60 * 1000);
      await expect(
        store.transitionStatus(streamId, {
          from: 'running',
          to: 'error',
          expectCreatedAt: recovery.createdAt,
          patch: { error: 'crashed before persistence', completedAt: Date.now() },
        }),
      ).resolves.toBe(true);

      const parked = await store.claimParkedSteers(streamId, item.userId);
      expect(JSON.parse(parked!)).toMatchObject({
        userId: item.userId,
        steers: [{ steerId: item.steerId, clientSteerId: item.clientSteerId }],
      });
      await expect(store.getSteerReceipt(streamId, item.clientSteerId!)).resolves.toMatchObject({
        state: 'leftover',
        item: { steerId: item.steerId },
      });
    } finally {
      nowSpy.mockRestore();
      await store.destroy();
    }
  });

  test('does not let a stale cancel discard a source leased to a live recovery', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'receipt-live-recovery-cancel';
    try {
      const { item, createdAt } = await enqueueReceiptSteer(store, streamId, 'live-recovery');
      await expect(store.closeAndDrainSteers(streamId, createdAt)).resolves.toEqual([item]);
      const recovery = await store.createJob(
        streamId,
        item.userId,
        streamId,
        undefined,
        {},
        item.steerId,
        undefined,
        undefined,
        undefined,
        {
          text: item.text,
          fileIds: (item.files ?? []).flatMap((file) => file.file_id ?? []).sort(),
          quotes: item.quotes ?? [],
        },
      );

      await expect(
        store.discardSteerLeftover(streamId, item.clientSteerId!, item.steerId, item.userId),
      ).resolves.toBe(false);
      await expect(
        store.consumeParkedSteer(
          streamId,
          item.steerId,
          item.userId,
          undefined,
          recovery.createdAt,
        ),
      ).resolves.toBe(true);
      await expect(store.getSteerReceipt(streamId, item.clientSteerId!)).resolves.toMatchObject({
        state: 'recovered',
      });
    } finally {
      await store.destroy();
    }
  });

  test('keeps host content and a delivered receipt when publication fails after commit', async () => {
    const store = new InMemoryJobStore();
    const transport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore: store, eventTransport: transport, isRedis: false });
    manager.initialize();

    const streamId = 'receipt-post-commit-publish-failure';
    const item: SteerQueueItem = {
      steerId: 'steer-post-commit',
      clientSteerId: 'client-post-commit',
      text: 'keep this instruction',
      userId: 'receipt-user',
      createdAt: Date.now(),
    };
    const hostContent: Array<{ steerId: string; text: string }> = [];
    let subscription: { unsubscribe: () => void } | null = null;

    try {
      const job = await manager.createJob(streamId, item.userId, streamId);
      await expect(
        store.enqueueSteerWithReceipt(
          streamId,
          item,
          {
            clientSteerId: item.clientSteerId!,
            fingerprint: 'fingerprint-post-commit',
            userId: item.userId,
            generationCreatedAt: job.createdAt,
          },
          false,
          job.createdAt,
        ),
      ).resolves.toMatchObject({ state: 'queued', item });
      await expect(store.drainSteers(streamId, job.createdAt)).resolves.toEqual([item]);

      // A live subscriber forces the in-memory manager through transport
      // publication instead of its no-subscriber replay buffer.
      subscription = await manager.subscribe(streamId, () => undefined);
      expect(subscription).not.toBeNull();
      jest.spyOn(transport, 'emitChunk').mockImplementation(() => {
        throw new Error('subscriber write failed');
      });

      const part = { steerId: item.steerId, text: item.text };
      const applyLikeAgentClient = async (): Promise<void> => {
        hostContent.push(part);
        try {
          await manager.emitChunk(
            streamId,
            {
              event: 'on_steer_applied',
              data: { steerId: item.steerId, index: 0, part },
            },
            {
              durable: true,
              expectedCreatedAt: job.createdAt,
              deliveredSteer: item,
            },
          );
        } catch (error) {
          hostContent.pop();
          throw error;
        }
      };

      await expect(applyLikeAgentClient()).resolves.toBeUndefined();
      expect(hostContent).toEqual([part]);
      await expect(store.peekClaimedSteers(streamId, job.createdAt)).resolves.toEqual([]);
      await expect(store.getSteerReceipt(streamId, item.clientSteerId!)).resolves.toMatchObject({
        state: 'delivered',
        item,
      });
    } finally {
      subscription?.unsubscribe();
      await manager.destroy();
    }
  });

  test('keeps a committed steer but retires its provider when publication is durably fenced', async () => {
    const store = new InMemoryJobStore();
    const transport = new InMemoryEventTransport();
    const manager = new GenerationJobManagerClass();
    manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
    manager.initialize();

    const streamId = 'receipt-post-commit-owner-fence';
    const item: SteerQueueItem = {
      steerId: 'steer-owner-fence',
      clientSteerId: 'client-owner-fence',
      text: 'commit before fencing',
      userId: 'receipt-user',
      createdAt: Date.now(),
    };
    const hostContent: Array<{ steerId: string; text: string }> = [];
    let subscription: { unsubscribe: () => void } | null = null;
    jest.useFakeTimers();

    try {
      const job = await manager.createJob(streamId, item.userId, streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      });
      await expect(
        store.enqueueSteerWithReceipt(
          streamId,
          item,
          {
            clientSteerId: item.clientSteerId!,
            fingerprint: 'fingerprint-owner-fence',
            userId: item.userId,
            generationCreatedAt: job.createdAt,
          },
          false,
          job.createdAt,
        ),
      ).resolves.toMatchObject({ state: 'queued', item });
      await expect(store.drainSteers(streamId, job.createdAt)).resolves.toEqual([item]);

      const onError = jest.fn();
      subscription = await manager.subscribe(streamId, () => undefined, undefined, onError);
      expect(subscription).not.toBeNull();
      registerChunkPublicationCapability(transport, async () => false);

      const part = { steerId: item.steerId, text: item.text };
      hostContent.push(part);
      await expect(
        manager.emitChunk(
          streamId,
          {
            event: 'on_steer_applied',
            data: { steerId: item.steerId, index: 0, part },
          },
          {
            durable: true,
            expectedCreatedAt: job.createdAt,
            deliveredSteer: item,
          },
        ),
      ).resolves.toBeUndefined();

      expect(hostContent).toEqual([part]);
      await expect(store.getSteerReceipt(streamId, item.clientSteerId!)).resolves.toMatchObject({
        state: 'delivered',
        item,
      });
      expect(job.abortController.signal.aborted).toBe(true);
      expect(onError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);

      await jest.advanceTimersByTimeAsync(REDIS_ABORT_TERMINAL_GRACE_MS);

      expect(onError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
    } finally {
      jest.useRealTimers();
      subscription?.unsubscribe();
      await manager.destroy();
    }
  });

  test('atomically settles a claimed receipt when its applied chunk commits', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'receipt-valid-delivery';
    try {
      const { item, createdAt } = await enqueueReceiptSteer(store, streamId, 'valid');

      await expect(store.drainSteers(streamId, createdAt)).resolves.toEqual([item]);
      await expect(
        store.appendChunk(
          streamId,
          { event: 'on_steer_applied', data: { steerId: item.steerId } },
          createdAt,
          item,
        ),
      ).resolves.toBe(true);

      await expect(store.peekClaimedSteers(streamId, createdAt)).resolves.toEqual([]);
      await expect(store.getSteerReceipt(streamId, item.clientSteerId!)).resolves.toMatchObject({
        state: 'delivered',
        item,
      });
    } finally {
      await store.destroy();
    }
  });

  test.each(receiptCorruptions)(
    'refuses to drain a queue with a $name receipt before moving any item',
    async ({ name, apply }) => {
      const store = new InMemoryJobStore();
      const streamId = `receipt-drain-${name}`;
      try {
        const { item, createdAt } = await enqueueReceiptSteer(store, streamId, `drain-${name}`);
        apply(receiptMap(store, streamId), item.clientSteerId!);

        await expect(store.drainSteers(streamId, createdAt)).rejects.toThrow(
          'Invalid steer receipt while draining',
        );
        await expect(store.peekSteers(streamId, createdAt)).resolves.toEqual([item]);
        await expect(store.peekClaimedSteers(streamId, createdAt)).resolves.toEqual([]);
      } finally {
        await store.destroy();
      }
    },
  );

  test.each(receiptCorruptions)(
    'refuses to arm with a $name receipt before mutating the queued item',
    async ({ name, apply }) => {
      const store = new InMemoryJobStore();
      const streamId = `receipt-arm-${name}`;
      try {
        const { item, createdAt } = await enqueueReceiptSteer(store, streamId, `arm-${name}`);
        await store.updateJob(streamId, { preemptCapable: true }, createdAt);
        apply(receiptMap(store, streamId), item.clientSteerId!);

        await expect(store.armSteerVersioned(streamId, item.steerId, createdAt)).rejects.toThrow(
          'Invalid steer receipt while arming',
        );
        await expect(store.peekSteers(streamId, createdAt)).resolves.toEqual([item]);
      } finally {
        await store.destroy();
      }
    },
  );

  test.each(receiptCorruptions)(
    'refuses to cancel with a $name receipt before mutating the queued item',
    async ({ name, apply }) => {
      const store = new InMemoryJobStore();
      const streamId = `receipt-cancel-${name}`;
      try {
        const { item, createdAt } = await enqueueReceiptSteer(store, streamId, `cancel-${name}`);
        apply(receiptMap(store, streamId), item.clientSteerId!);

        await expect(store.removeSteer(streamId, item.steerId, createdAt)).rejects.toThrow(
          'Invalid steer receipt while cancelling',
        );
        await expect(store.peekSteers(streamId, createdAt)).resolves.toEqual([item]);
      } finally {
        await store.destroy();
      }
    },
  );

  test.each(receiptCorruptions)(
    'refuses to downgrade with a $name receipt before mutating any queued item',
    async ({ name, apply }) => {
      const store = new InMemoryJobStore();
      const streamId = `receipt-downgrade-${name}`;
      try {
        const job = await store.createJob(streamId, 'receipt-user', streamId, undefined, {
          preemptCapable: true,
        });
        const item: SteerQueueItem = {
          steerId: `steer-downgrade-${name}`,
          clientSteerId: `client-downgrade-${name}`,
          text: `instruction downgrade-${name}`,
          userId: 'receipt-user',
          createdAt: Date.now(),
        };
        await expect(
          store.enqueueSteerWithReceipt(
            streamId,
            item,
            {
              clientSteerId: item.clientSteerId!,
              fingerprint: `fingerprint-downgrade-${name}`,
              userId: item.userId,
              generationCreatedAt: job.createdAt,
            },
            true,
            job.createdAt,
          ),
        ).resolves.toMatchObject({ state: 'queued', item: { preempt: true, preemptRevision: 1 } });
        const armedItem = (await store.peekSteers(streamId, job.createdAt))[0];
        await store.updateJob(streamId, { preemptCapable: false }, job.createdAt);
        apply(receiptMap(store, streamId), item.clientSteerId!);

        await expect(store.downgradeSteerPreempts(streamId, job.createdAt)).rejects.toThrow(
          'Invalid steer receipt while downgrading',
        );
        await expect(store.peekSteers(streamId, job.createdAt)).resolves.toEqual([armedItem]);
      } finally {
        await store.destroy();
      }
    },
  );

  test.each(receiptCorruptions)(
    'refuses to settle a claimed steer with a $name receipt before removing its claim',
    async ({ name, apply }) => {
      const store = new InMemoryJobStore();
      const streamId = `receipt-append-${name}`;
      try {
        const { item, createdAt } = await enqueueReceiptSteer(store, streamId, `append-${name}`);
        await expect(store.drainSteers(streamId, createdAt)).resolves.toEqual([item]);
        apply(receiptMap(store, streamId), item.clientSteerId!);

        await expect(
          store.appendChunk(
            streamId,
            { event: 'on_steer_applied', data: { steerId: item.steerId } },
            createdAt,
            item,
          ),
        ).resolves.toBe(false);
        await expect(store.peekSteers(streamId, createdAt)).resolves.toEqual([]);
        await expect(store.peekClaimedSteers(streamId, createdAt)).resolves.toEqual([item]);
      } finally {
        await store.destroy();
      }
    },
  );

  test.each(receiptCorruptions)(
    'refuses to restore a claimed steer with a $name receipt before changing either list',
    async ({ name, apply }) => {
      const store = new InMemoryJobStore();
      const streamId = `receipt-restore-${name}`;
      try {
        const { item, createdAt } = await enqueueReceiptSteer(store, streamId, `restore-${name}`);
        await expect(store.drainSteers(streamId, createdAt)).resolves.toEqual([item]);
        apply(receiptMap(store, streamId), item.clientSteerId!);

        await expect(store.restoreClaimedSteers(streamId, [item], createdAt)).resolves.toBe(false);
        await expect(store.peekSteers(streamId, createdAt)).resolves.toEqual([]);
        await expect(store.peekClaimedSteers(streamId, createdAt)).resolves.toEqual([item]);
      } finally {
        await store.destroy();
      }
    },
  );

  test('refuses a 101st receipt without evicting replay evidence or queueing the item', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'receipt-cap';
    try {
      const job = await store.createJob(streamId, 'receipt-user', streamId);
      for (let index = 0; index < 100; index++) {
        const item: SteerQueueItem = {
          steerId: `steer-cap-${index}`,
          clientSteerId: `client-cap-${index}`,
          text: `instruction ${index}`,
          userId: 'receipt-user',
          createdAt: Date.now(),
        };
        await expect(
          store.enqueueSteerWithReceipt(
            streamId,
            item,
            {
              clientSteerId: item.clientSteerId!,
              fingerprint: `fingerprint-${index}`,
              userId: item.userId,
              generationCreatedAt: job.createdAt,
            },
            false,
            job.createdAt,
          ),
        ).resolves.toMatchObject({ state: 'queued', item });
        await expect(store.removeSteer(streamId, item.steerId)).resolves.toBe(true);
      }

      const overflow: SteerQueueItem = {
        steerId: 'steer-cap-overflow',
        clientSteerId: 'client-cap-overflow',
        text: 'must not queue',
        userId: 'receipt-user',
        createdAt: Date.now(),
      };
      await expect(
        store.enqueueSteerWithReceipt(
          streamId,
          overflow,
          {
            clientSteerId: overflow.clientSteerId!,
            fingerprint: 'fingerprint-overflow',
            userId: overflow.userId,
            generationCreatedAt: job.createdAt,
          },
          false,
          job.createdAt,
        ),
      ).resolves.toBe(STEER_ENQUEUE_RECEIPT_FULL);

      await expect(store.peekSteers(streamId, job.createdAt)).resolves.toEqual([]);
      await expect(store.getSteerReceipt(streamId, 'client-cap-overflow')).resolves.toBeNull();
      await expect(store.getSteerReceipt(streamId, 'client-cap-0')).resolves.toMatchObject({
        state: 'cancelled',
        item: { steerId: 'steer-cap-0' },
      });
    } finally {
      await store.destroy();
    }
  });
});
