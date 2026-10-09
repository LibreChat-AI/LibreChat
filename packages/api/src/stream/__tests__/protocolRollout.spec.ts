import type { SteerQueueItem, SteerReceiptInput } from '../interfaces/IJobStore';
import { InMemoryJobStore } from '../implementations/InMemoryJobStore';

function steer(id: string): SteerQueueItem {
  return {
    steerId: id,
    clientSteerId: `client-${id}`,
    text: `text-${id}`,
    userId: 'user-1',
    createdAt: Date.now(),
  };
}

function receipt(item: SteerQueueItem, createdAt: number): SteerReceiptInput {
  return {
    clientSteerId: item.clientSteerId!,
    fingerprint: `fingerprint-${item.steerId}`,
    userId: item.userId,
    generationCreatedAt: createdAt,
  };
}

describe('generation protocol rollout storage', () => {
  test('in-memory defaults to v2 while an explicit v1 omits checkpoint isolation', async () => {
    const store = new InMemoryJobStore();
    const v2 = await store.createJob('protocol-v2', 'user-1');
    const v1 = await store.createJob('protocol-v1', 'user-1', undefined, undefined, {
      generationProtocolVersion: 1,
    });

    expect(v2.generationProtocolVersion).toBe(2);
    expect(v2.checkpointNamespace).toEqual(expect.any(String));
    expect(v2.checkpointNamespace).not.toBe(String(v2.createdAt));
    expect(v1.generationProtocolVersion).toBe(1);
    expect(v1.checkpointNamespace).toBeUndefined();
  });

  test('jobs receive distinct globally unique checkpoint scopes under a frozen clock', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const store = new InMemoryJobStore();
      const first = await store.createJob('stream-a', 'owner-a', 'shared-conversation', undefined, {
        providerExecutionId: 'shared-execution',
      });
      const second = await store.createJob(
        'stream-b',
        'owner-b',
        'shared-conversation',
        undefined,
        {
          providerExecutionId: 'shared-execution',
        },
      );

      expect(second.createdAt).toBeGreaterThan(first.createdAt);
      expect(first.checkpointNamespace).not.toBe(second.checkpointNamespace);
      expect(first.checkpointNamespace).toMatch(/^lcg:v2:[0-9a-f]{64}:[0-9a-f-]{36}$/);
      expect(second.checkpointNamespace).toMatch(/^lcg:v2:[0-9a-f]{64}:[0-9a-f-]{36}$/);
    } finally {
      now.mockRestore();
    }
  });

  test('v1 steering stays receiptless and uses the legacy destructive drain', async () => {
    const store = new InMemoryJobStore();
    const job = await store.createJob('protocol-v1-steer', 'user-1', undefined, undefined, {
      generationProtocolVersion: 1,
      preemptCapable: true,
    });
    const item = steer('v1');

    const enqueued = await store.enqueueSteerWithReceipt(
      job.streamId,
      item,
      receipt(item, job.createdAt),
      true,
      job.createdAt,
    );
    expect(enqueued).toMatchObject({ position: 1, item: { steerId: item.steerId } });
    expect(enqueued).not.toHaveProperty('state');
    expect(await store.getSteerReceipt(job.streamId, item.clientSteerId!)).toBeNull();

    const drained = await store.drainSteers(job.streamId, job.createdAt);
    expect(drained).toHaveLength(1);
    expect(await store.peekClaimedSteers(job.streamId, job.createdAt)).toEqual([]);
    expect(
      await store.appendChunk(job.streamId, { event: 'chunk' }, job.createdAt, drained[0]),
    ).toBe(true);
  });

  test('a v1 requester destructively downgrades even a v2 parked envelope', async () => {
    const store = new InMemoryJobStore();
    const job = await store.createJob('protocol-park-downgrade', 'user-1');
    await store.parkSteers(
      job.streamId,
      JSON.stringify({
        userId: 'user-1',
        steers: [{ steerId: 'parked', text: 'keep me', createdAt: Date.now() }],
      }),
      job.createdAt,
    );

    const replayable = await store.claimParkedSteersDetailed(job.streamId, 'user-1', undefined, 2);
    expect(replayable?.generationProtocolVersion).toBe(2);
    expect(
      await store.claimParkedSteersDetailed(job.streamId, 'user-1', undefined, 2),
    ).toBeDefined();

    const downgraded = await store.claimParkedSteersDetailed(job.streamId, 'user-1', undefined, 1);
    expect(downgraded?.generationProtocolVersion).toBe(1);
    expect(JSON.parse(downgraded!.payload)).toMatchObject({ generationProtocolVersion: 1 });
    expect(
      await store.claimParkedSteersDetailed(job.streamId, 'user-1', undefined, 2),
    ).toBeUndefined();
  });

  test('a v1 requester takes only unleased leftovers during an active v2 recovery', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'protocol-park-active-v2-lease';
    const job = await store.createJob(streamId, 'user-1', undefined, undefined, {
      generationProtocolVersion: 2,
    });
    const leased = { steerId: 'leased-v2', text: 'leased words', createdAt: 1 };
    const legacy = { steerId: 'visible-v1', text: 'legacy words', createdAt: 2 };
    await store.parkSteers(
      streamId,
      JSON.stringify({ userId: 'user-1', steers: [leased, legacy] }),
      job.createdAt,
    );
    const recovery = await store.createJob(
      streamId,
      'user-1',
      undefined,
      undefined,
      { generationProtocolVersion: 2 },
      leased.steerId,
      undefined,
      undefined,
      undefined,
      { text: leased.text, fileIds: [], quotes: [] },
    );

    const downgraded = await store.claimParkedSteersDetailed(streamId, 'user-1', undefined, 1);
    expect(downgraded?.generationProtocolVersion).toBe(1);
    expect(JSON.parse(downgraded!.payload)).toEqual({
      userId: 'user-1',
      generationProtocolVersion: 1,
      steers: [legacy],
    });
    await expect(
      store.claimParkedSteersDetailed(streamId, 'user-1', undefined, 2),
    ).resolves.toBeUndefined();

    await expect(
      store.transitionStatus(streamId, {
        from: 'running',
        to: 'error',
        expectCreatedAt: recovery.createdAt,
        patch: { error: 'recovery failed', completedAt: Date.now() },
      }),
    ).resolves.toBe(true);
    const exposed = await store.claimParkedSteersDetailed(streamId, 'user-1', undefined, 2);
    expect(JSON.parse(exposed!.payload)).toEqual({
      userId: 'user-1',
      generationProtocolVersion: 2,
      steers: [leased],
    });
  });

  test('a v1 parked envelope remains destructive for a v2 requester', async () => {
    const store = new InMemoryJobStore();
    const job = await store.createJob('protocol-park-v1', 'user-1', undefined, undefined, {
      generationProtocolVersion: 1,
    });
    await store.parkSteers(
      job.streamId,
      JSON.stringify({
        userId: 'user-1',
        steers: [{ steerId: 'legacy', text: 'legacy words', createdAt: Date.now() }],
      }),
      job.createdAt,
    );

    expect(
      (await store.claimParkedSteersDetailed(job.streamId, 'user-1', undefined, 2))
        ?.generationProtocolVersion,
    ).toBe(1);
    expect(
      await store.claimParkedSteersDetailed(job.streamId, 'user-1', undefined, 2),
    ).toBeUndefined();
  });

  test('cannot upgrade a v1 parked item into the v2 lease protocol implicitly', async () => {
    const store = new InMemoryJobStore();
    const streamId = 'protocol-v1-source';
    const job = await store.createJob(streamId, 'user-1', undefined, undefined, {
      generationProtocolVersion: 1,
    });
    await store.parkSteers(
      streamId,
      JSON.stringify({
        userId: 'user-1',
        steers: [{ steerId: 'legacy', text: 'legacy words', createdAt: Date.now() }],
      }),
      job.createdAt,
    );

    await expect(
      store.createJob(
        streamId,
        'user-1',
        undefined,
        undefined,
        { generationProtocolVersion: 2 },
        'legacy',
        undefined,
        undefined,
        undefined,
        { text: 'legacy words', fileIds: [], quotes: [] },
      ),
    ).rejects.toMatchObject({ code: 'RECOVERY_PAYLOAD_MISMATCH' });
  });

  test('marks a token-owned idempotency bridge key started idempotently', async () => {
    const store = new InMemoryJobStore();
    await store.claimIdempotencyKey(
      'legacy:user:req',
      { streamId: 'stream-1', conversationId: 'stream-1', claimToken: 'token-1' },
      60,
    );

    expect(await store.markIdempotencyKeyStarted('legacy:user:req', 'token-1', 1234, 60)).toBe(
      true,
    );
    expect(await store.markIdempotencyKeyStarted('legacy:user:req', 'token-1', 1234, 60)).toBe(
      true,
    );
    expect(await store.markIdempotencyKeyStarted('legacy:user:req', 'token-1', 1235, 60)).toBe(
      false,
    );
  });
});
