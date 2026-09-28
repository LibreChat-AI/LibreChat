import {
  REDIS_ABORT_TERMINAL_GRACE_MS,
  REDIS_EVENT_REORDER_TIMEOUT_MS,
  REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS,
} from '~/stream/internal/timing';
import {
  JobCreationSupersededError,
  type CreatedJobData,
  type IEventTransport,
} from '~/stream/interfaces/IJobStore';
import {
  GenerationJobManagerClass,
  TERMINAL_PUBLICATION_RECONNECT_ERROR,
} from '~/stream/GenerationJobManager';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { registerChunkPublicationCapability } from '~/stream/internal/chunkPublication';
import { buildPendingAction, buildToolApprovalPayload } from '~/agents/hitl/policy';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';

jest.spyOn(console, 'log').mockImplementation();

/**
 * Start-generation idempotency: a retried start request for the SAME submission must
 * attach to the original stream instead of spawning a second billed generation, while a
 * distinct submission (including a regenerate) must NOT be deduped. See issue #14339.
 */
describe('InMemoryJobStore.claimIdempotencyKey', () => {
  let store: InMemoryJobStore;

  beforeEach(() => {
    store = new InMemoryJobStore({ ttlAfterComplete: 0 });
  });

  it('grants the first claim and returns the original stream to a duplicate', async () => {
    const first = await store.claimIdempotencyKey(
      'user:req',
      { streamId: 's1', conversationId: 'c1' },
      1200,
    );
    expect(first).toEqual({
      claimed: true,
      existing: { streamId: 's1', conversationId: 'c1' },
    });

    // A retry that computed a different streamId still gets the ORIGINAL stream back.
    const second = await store.claimIdempotencyKey(
      'user:req',
      { streamId: 's2', conversationId: 'c2' },
      1200,
    );
    expect(second).toEqual({ claimed: false, existing: { streamId: 's1', conversationId: 'c1' } });
  });

  it('probes an existing claim without creating a missing key', async () => {
    await expect(store.hasIdempotencyKey('user:missing')).resolves.toBe(false);

    await store.claimIdempotencyKey(
      'user:existing',
      { streamId: 's1', conversationId: 'c1' },
      1200,
    );

    await expect(store.hasIdempotencyKey('user:existing')).resolves.toBe(true);
    await expect(store.hasIdempotencyKey('user:missing')).resolves.toBe(false);
  });

  it('reads an idempotency receipt without creating a missing claim', async () => {
    const receipt = {
      streamId: 's1',
      conversationId: 'c1',
      claimToken: 'token-1',
      claimedAt: 1,
      startedAt: 2,
    };
    await expect(store.getIdempotencyClaim('user:missing')).resolves.toBeNull();
    await store.claimIdempotencyKey('user:existing', receipt, 1200);
    await expect(store.getIdempotencyClaim('user:existing')).resolves.toEqual(receipt);
    await expect(store.hasIdempotencyKey('user:missing')).resolves.toBe(false);
  });

  it('does not report an expired claim as existing', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-08-29T00:00:00Z'));
      await store.claimIdempotencyKey('user:expired', { streamId: 's1', conversationId: 'c1' }, 1);
      await expect(store.hasIdempotencyKey('user:expired')).resolves.toBe(true);

      jest.setSystemTime(new Date('2026-08-29T00:00:02Z'));
      await expect(store.hasIdempotencyKey('user:expired')).resolves.toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('lets a released key be claimed again', async () => {
    await store.claimIdempotencyKey('user:req', { streamId: 's1', conversationId: 'c1' }, 1200);
    await store.releaseIdempotencyKey('user:req');

    const reclaimed = await store.claimIdempotencyKey(
      'user:req',
      { streamId: 's2', conversationId: 'c2' },
      1200,
    );
    expect(reclaimed).toEqual({
      claimed: true,
      existing: { streamId: 's2', conversationId: 'c2' },
    });
  });

  it('clears claims on destroy so a reused store does not falsely dedup', async () => {
    await store.claimIdempotencyKey('user:req', { streamId: 's1', conversationId: 'c1' }, 1200);
    await store.destroy();
    const reclaimed = await store.claimIdempotencyKey(
      'user:req',
      { streamId: 's2', conversationId: 'c2' },
      1200,
    );
    expect(reclaimed).toEqual({
      claimed: true,
      existing: { streamId: 's2', conversationId: 'c2' },
    });
  });

  it('treats distinct keys independently', async () => {
    const a = await store.claimIdempotencyKey(
      'user:reqA',
      { streamId: 's1', conversationId: 'c1' },
      1200,
    );
    const b = await store.claimIdempotencyKey(
      'user:reqB',
      { streamId: 's2', conversationId: 'c2' },
      1200,
    );
    expect(a).toEqual({
      claimed: true,
      existing: { streamId: 's1', conversationId: 'c1' },
    });
    expect(b).toEqual({
      claimed: true,
      existing: { streamId: 's2', conversationId: 'c2' },
    });
  });

  it('lets the key be reclaimed after its TTL elapses', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-07-20T00:00:00Z'));
      const first = await store.claimIdempotencyKey(
        'user:req',
        { streamId: 's1', conversationId: 'c1' },
        1,
      );
      expect(first).toEqual({
        claimed: true,
        existing: { streamId: 's1', conversationId: 'c1' },
      });

      // Still held one moment before expiry.
      jest.setSystemTime(new Date('2026-07-20T00:00:00.999Z'));
      const held = await store.claimIdempotencyKey(
        'user:req',
        { streamId: 's2', conversationId: 'c2' },
        1,
      );
      expect(held.claimed).toBe(false);

      // Expired: the next caller wins.
      jest.setSystemTime(new Date('2026-07-20T00:00:02Z'));
      const expired = await store.claimIdempotencyKey(
        'user:req',
        { streamId: 's3', conversationId: 'c3' },
        1,
      );
      expect(expired).toEqual({
        claimed: true,
        existing: { streamId: 's3', conversationId: 'c3' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects partial low-level create idempotency arguments before mutation', async () => {
    await expect(
      store.createJob(
        'partial-store-idempotency',
        'user-1',
        undefined,
        undefined,
        {},
        undefined,
        '{partial-store-idempotency}:user-1:req',
        'claim-token',
      ),
    ).rejects.toThrow('Invalid generation job idempotency arguments');
    await expect(store.getJob('partial-store-idempotency')).resolves.toBeNull();
  });
});

describe('GenerationJobManager start-generation claim', () => {
  let manager: GenerationJobManagerClass;
  let store: InMemoryJobStore;

  beforeEach(() => {
    store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
    });
    manager.initialize();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  it('dedups a retry of the same submission to the original stream', async () => {
    const first = await manager.claimGeneration('user-1', 'req-1', 'stream-a', 'convo-a');
    expect(first).toEqual({
      claimed: true,
      source: 'primary',
      existing: expect.objectContaining({
        streamId: 'stream-a',
        conversationId: 'convo-a',
        claimToken: expect.any(String),
        claimedAt: expect.any(Number),
      }),
    });

    const retry = await manager.claimGeneration('user-1', 'req-1', 'stream-a', 'convo-a');
    expect(retry.claimed).toBe(false);
    expect(retry.existing).toEqual(
      expect.objectContaining({ streamId: 'stream-a', conversationId: 'convo-a' }),
    );
    expect(typeof retry.existing?.claimedAt).toBe('number');
  });

  it('detects only an already-claimed submission for pre-limiter retry admission', async () => {
    await expect(manager.hasGenerationClaim('user-1', 'req-1')).resolves.toBe(false);

    await manager.claimGeneration('user-1', 'req-1', 'stream-a', 'convo-a');

    await expect(manager.hasGenerationClaim('user-1', 'req-1')).resolves.toBe(true);
    await expect(manager.hasGenerationClaim('user-1', 'req-2')).resolves.toBe(false);
    await expect(manager.hasGenerationClaim('user-2', 'req-1')).resolves.toBe(false);
  });

  it('reads durable admission evidence after the live job is gone', async () => {
    await store.claimIdempotencyKey(
      '{stream-a}:user-1:req-1',
      {
        streamId: 'stream-a',
        conversationId: 'convo-a',
        claimToken: 'claim-token',
        claimedAt: 1,
        startedAt: 42,
      },
      1200,
    );

    await expect(
      manager.getGenerationAdmissionEvidence('user-1', 'req-1', 'stream-a', 'convo-a'),
    ).resolves.toEqual({ generationId: 'stream-a', generationCreatedAt: 42 });
    await expect(
      manager.getGenerationAdmissionEvidence('user-1', 'req-2', 'stream-a', 'convo-a'),
    ).resolves.toBeNull();
  });

  it('claims the exact legacy key before the same-slot primary with staggered TTLs', async () => {
    const claimSpy = jest.spyOn(store, 'claimIdempotencyKey');
    const result = await manager.claimGeneration(
      'user-1',
      'req-order',
      'stream-order',
      'stream-order',
      2,
    );

    expect(result).toMatchObject({ claimed: true, source: 'primary' });
    expect(claimSpy).toHaveBeenNthCalledWith(
      1,
      '{user-1:req-order}',
      expect.objectContaining({
        streamId: 'stream-order',
        generationProtocolVersion: 2,
        claimToken: expect.any(String),
      }),
      26 * 60 * 60,
    );
    expect(claimSpy).toHaveBeenNthCalledWith(
      2,
      '{stream-order}:user-1:req-order',
      expect.objectContaining({
        streamId: 'stream-order',
        generationProtocolVersion: 2,
        claimToken: result.existing?.claimToken,
      }),
      25 * 60 * 60,
    );
  });

  it('keeps an old tokenless legacy claim duplicate-only without binding a primary', async () => {
    const oldClaim = {
      streamId: 'old-random-stream',
      conversationId: 'old-random-stream',
      claimedAt: Date.now(),
    };
    await store.claimIdempotencyKey('{user-1:req-legacy}', oldClaim, 1200);
    const claimSpy = jest.spyOn(store, 'claimIdempotencyKey');
    const takeoverSpy = jest.spyOn(store, 'takeoverIdempotencyKey');

    const result = await manager.claimGeneration(
      'user-1',
      'req-legacy',
      'new-stable-stream',
      'new-stable-stream',
      2,
    );
    expect(result).toEqual({
      claimed: false,
      source: 'legacy',
      existing: { ...oldClaim, generationProtocolVersion: 1 },
    });
    expect(claimSpy).toHaveBeenCalledTimes(1);

    await expect(
      manager.takeoverGeneration('user-1', 'req-legacy', 'new-stable-stream', result.existing!),
    ).resolves.toEqual(result);
    expect(takeoverSpy).not.toHaveBeenCalled();
  });

  it('elects exactly one manager winner while both durable keys converge', async () => {
    const [first, second] = await Promise.all([
      manager.claimGeneration('user-1', 'req-race', 'stream-race', 'stream-race', 2),
      manager.claimGeneration('user-1', 'req-race', 'stream-race', 'stream-race', 2),
    ]);

    expect([first, second].filter((result) => result.claimed)).toHaveLength(1);
    expect([first, second].filter((result) => !result.claimed)).toHaveLength(1);
    expect(first.existing?.claimToken).toBe(second.existing?.claimToken);
    expect(first.existing?.generationProtocolVersion).toBe(2);
    expect(second.existing?.generationProtocolVersion).toBe(2);
  });

  it('marks primary and legacy claims started before createJob returns', async () => {
    const claim = await manager.claimGeneration(
      'user-1',
      'req-started',
      'stream-started',
      'stream-started',
      2,
    );
    const job = await manager.createJob('stream-started', 'user-1', 'stream-started', {
      idempotencyClientRequestId: 'req-started',
      idempotencyClaimToken: claim.existing!.claimToken,
      initialMetadata: { generationProtocolVersion: 2 },
    });

    for (const key of ['{user-1:req-started}', '{stream-started}:user-1:req-started']) {
      const stored = await store.claimIdempotencyKey(
        key,
        { streamId: 'wrong', conversationId: 'wrong' },
        60,
      );
      expect(stored).toMatchObject({
        claimed: false,
        existing: {
          claimToken: claim.existing!.claimToken,
          startedAt: job.createdAt,
          generationProtocolVersion: 2,
        },
      });
    }
  });

  it('fences a missing continuation claim as a settled recovery tombstone', async () => {
    await expect(
      manager.fenceGenerationClaimForRecovery(
        'user-1',
        'req-recovered',
        'stream-recovered',
        'stream-recovered',
      ),
    ).resolves.toBe('fenced');

    await expect(
      manager.claimGeneration('user-1', 'req-recovered', 'stream-recovered', 'stream-recovered'),
    ).resolves.toMatchObject({
      claimed: false,
      existing: { startedAt: expect.any(Number) },
    });
  });

  it('invalidates an unpublished continuation creator before manual recovery', async () => {
    const original = await manager.claimGeneration(
      'user-1',
      'req-recovery-race',
      'stream-recovery-race',
      'stream-recovery-race',
      2,
    );

    await expect(
      manager.fenceGenerationClaimForRecovery(
        'user-1',
        'req-recovery-race',
        'stream-recovery-race',
        'stream-recovery-race',
      ),
    ).resolves.toBe('fenced');
    await expect(
      manager.createJob('stream-recovery-race', 'user-1', 'stream-recovery-race', {
        idempotencyClientRequestId: 'req-recovery-race',
        idempotencyClaimToken: original.existing!.claimToken,
        initialMetadata: { generationProtocolVersion: 2 },
      }),
    ).rejects.toThrow('Generation idempotency claim was taken over before job creation');
    await expect(store.getJob('stream-recovery-race')).resolves.toBeNull();
  });

  it('reports started when generation creation wins the recovery fence', async () => {
    const claim = await manager.claimGeneration(
      'user-1',
      'req-created-first',
      'stream-created-first',
      'stream-created-first',
      2,
    );
    await manager.createJob('stream-created-first', 'user-1', 'stream-created-first', {
      idempotencyClientRequestId: 'req-created-first',
      idempotencyClaimToken: claim.existing!.claimToken,
      initialMetadata: { generationProtocolVersion: 2 },
    });

    await expect(
      manager.fenceGenerationClaimForRecovery(
        'user-1',
        'req-created-first',
        'stream-created-first',
        'stream-created-first',
      ),
    ).resolves.toBe('started');
  });

  it('accepts an exact legacy started mark whose committed reply was lost', async () => {
    const streamId = 'stream-lost-legacy-mark-reply';
    const clientRequestId = 'req-lost-legacy-mark-reply';
    const claim = await manager.claimGeneration('user-1', clientRequestId, streamId, streamId, 2);
    const actualMark = store.markIdempotencyKeyStarted.bind(store);
    jest.spyOn(store, 'markIdempotencyKeyStarted').mockImplementationOnce(async (...args) => {
      expect(await actualMark(...args)).toBe(true);
      throw new Error('simulated lost legacy mark reply');
    });

    const job = await manager.createJob(streamId, 'user-1', streamId, {
      idempotencyClientRequestId: clientRequestId,
      idempotencyClaimToken: claim.existing!.claimToken,
      initialMetadata: { generationProtocolVersion: 2 },
    });

    expect(job).toMatchObject({ streamId, status: 'running' });
    const legacy = await store.claimIdempotencyKey(
      `{user-1:${clientRequestId}}`,
      { streamId: 'wrong', conversationId: 'wrong' },
      60,
    );
    expect(legacy).toMatchObject({
      claimed: false,
      existing: {
        streamId,
        conversationId: streamId,
        claimToken: claim.existing!.claimToken,
        startedAt: job.createdAt,
        generationProtocolVersion: 2,
      },
    });
  });

  it.each([
    {
      name: 'request id only',
      options: { idempotencyClientRequestId: 'req-partial' },
    },
    {
      name: 'claim token only',
      options: { idempotencyClaimToken: 'claim-token' },
    },
    {
      name: 'empty claim token',
      options: { idempotencyClientRequestId: 'req-partial', idempotencyClaimToken: '' },
    },
  ])('rejects $name before reading or creating a job', async ({ options }) => {
    const getSpy = jest.spyOn(store, 'getJob');
    const createSpy = jest.spyOn(store, 'createJob');
    await expect(
      manager.createJob('stream-partial-idempotency', 'user-1', 'stream-partial-idempotency', {
        ...options,
      }),
    ).rejects.toThrow(/provided together|invalid/);
    expect(getSpy).not.toHaveBeenCalled();
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('recovers a job whose atomic create committed before its reply was lost', async () => {
    const streamId = 'stream-lost-create-reply';
    const clientRequestId = 'req-lost-create-reply';
    const claim = await manager.claimGeneration('user-1', clientRequestId, streamId, streamId, 2);
    const actualCreate = store.createJob.bind(store);
    let injectLostReply = true;
    jest.spyOn(store, 'createJob').mockImplementation(async (...args) => {
      const created = await actualCreate(...args);
      if (injectLostReply) {
        injectLostReply = false;
        throw new Error('simulated lost atomic create reply');
      }
      return created;
    });
    const membershipRepair = jest.spyOn(store, 'transitionStatus');

    const job = await manager.createJob(streamId, 'user-1', streamId, {
      idempotencyClientRequestId: clientRequestId,
      idempotencyClaimToken: claim.existing!.claimToken,
      initialMetadata: { generationProtocolVersion: 2 },
    });

    expect(job).toMatchObject({ streamId, status: 'running' });
    expect(membershipRepair).toHaveBeenCalledWith(streamId, {
      from: 'running',
      to: 'running',
      expectCreatedAt: job.createdAt,
    });
    expect(await store.getActiveJobIdsByUser('user-1')).toContain(streamId);
    expect(await manager.getJob(streamId)).toMatchObject({ createdAt: job.createdAt });

    for (const key of [`{user-1:${clientRequestId}}`, `{${streamId}}:user-1:${clientRequestId}`]) {
      const stored = await store.claimIdempotencyKey(key, claim.existing!, 60);
      expect(stored).toMatchObject({
        claimed: false,
        existing: {
          claimToken: claim.existing!.claimToken,
          startedAt: job.createdAt,
          generationProtocolVersion: 2,
        },
      });
    }

    const retry = await manager.claimGeneration('user-1', clientRequestId, streamId, streamId, 2);
    expect(retry).toMatchObject({
      claimed: false,
      existing: { startedAt: job.createdAt },
    });
    await expect(
      manager.takeoverGeneration('user-1', clientRequestId, streamId, retry.existing!),
    ).resolves.toMatchObject({ claimed: false });
  });

  it('recovers a direct create with no public idempotency key after its committed reply is lost', async () => {
    const streamId = 'stream-direct-lost-create-reply';
    const actualCreate = store.createJob.bind(store);
    let injectLostReply = true;
    jest.spyOn(store, 'createJob').mockImplementation(async (...args) => {
      const created = await actualCreate(...args);
      if (injectLostReply) {
        injectLostReply = false;
        throw new Error('simulated lost direct create reply');
      }
      return created;
    });
    const membershipRepair = jest.spyOn(store, 'transitionStatus');

    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });

    expect(job).toMatchObject({ streamId, status: 'running' });
    expect(membershipRepair).toHaveBeenCalledWith(streamId, {
      from: 'running',
      to: 'running',
      expectCreatedAt: job.createdAt,
    });
    const durable = await store.getJob(streamId);
    expect(durable).toMatchObject({ createdAt: job.createdAt, status: 'running' });
    expect(Object.getOwnPropertyDescriptor(durable!, 'creationAttemptId')?.value).toEqual(
      expect.any(String),
    );
    expect(await store.getActiveJobIdsByUser('user-1')).toContain(streamId);
  });

  it('does not let an older create resume after handoff and overwrite a newer local runtime', async () => {
    await manager.destroy();
    store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    const transport: IEventTransport = new InMemoryEventTransport();
    const actualDone = transport.emitDone.bind(transport);
    let releaseFirstDone!: () => void;
    let enteredFirstDone!: () => void;
    const firstDoneEntered = new Promise<void>((resolve) => {
      enteredFirstDone = resolve;
    });
    const firstDoneGate = new Promise<void>((resolve) => {
      releaseFirstDone = resolve;
    });
    let blockFirstDone = true;
    transport.emitDone = (streamId, event, generationId) => {
      const emitted = actualDone(streamId, event, generationId);
      if (blockFirstDone) {
        blockFirstDone = false;
        enteredFirstDone();
        return Promise.resolve(emitted).then(() => firstDoneGate);
      }
      return emitted;
    };
    manager = new GenerationJobManagerClass();
    manager.configure({ jobStore: store, eventTransport: transport, isRedis: false });
    manager.initialize();

    const streamId = 'stream-local-install-race';
    const first = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const olderCreate = manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    await firstDoneEntered;

    const newer = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    expect(newer.createdAt).toBeGreaterThan(first.createdAt);
    expect(newer.abortController.signal.aborted).toBe(false);

    releaseFirstDone();
    await expect(olderCreate).rejects.toThrow('replaced during initialization');
    expect(newer.abortController.signal.aborted).toBe(false);
    expect(await store.getJob(streamId)).toMatchObject({
      createdAt: newer.createdAt,
      status: 'running',
    });
    expect(await manager.getJob(streamId)).toMatchObject({
      createdAt: newer.createdAt,
      abortController: newer.abortController,
    });
  });

  it('does not let a superseded helper acknowledge the current creator receipts', async () => {
    await manager.destroy();
    store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    const transport = new InMemoryEventTransport() as InMemoryEventTransport & IEventTransport;
    const actualDone = transport.emitDone.bind(transport);
    transport.emitAbortConfirmed = jest.fn().mockResolvedValue(undefined);

    let releaseOwnerPublish!: () => void;
    let ownerPublishEntered!: () => void;
    const ownerPublishGate = new Promise<void>((resolve) => {
      releaseOwnerPublish = resolve;
    });
    const ownerPublishStarted = new Promise<void>((resolve) => {
      ownerPublishEntered = resolve;
    });
    let replacementPublishCount = 0;
    transport.emitReplacedDoneConfirmed = async (
      streamId,
      event,
      replacedGenerationId,
      creationAttemptId,
    ) => {
      replacementPublishCount += 1;
      if (replacementPublishCount === 1) {
        ownerPublishEntered();
        await ownerPublishGate;
      }
      const current = (await store.getJob(streamId)) as CreatedJobData | null;
      const receipts =
        current?.replacedJobs ?? (current?.replacedJob != null ? [current.replacedJob] : []);
      if (
        current?.creationAttemptId !== creationAttemptId ||
        !receipts.some((receipt) => receipt.createdAt === replacedGenerationId)
      ) {
        throw new Error('replacement receipt was already acknowledged');
      }
      actualDone(streamId, event, replacedGenerationId);
    };

    manager = new GenerationJobManagerClass();
    manager.configure({ jobStore: store, eventTransport: transport, isRedis: false });
    manager.initialize();
    const supersededManager = new GenerationJobManagerClass();
    supersededManager.configure({ jobStore: store, eventTransport: transport, isRedis: false });
    supersededManager.initialize();

    try {
      const streamId = 'stream-superseded-receipt-owner';
      const initial = await manager.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      });
      const actualCreate = store.createJob.bind(store);
      let releaseSupersededReply!: () => void;
      let supersededCommitObserved!: () => void;
      const supersededReplyGate = new Promise<void>((resolve) => {
        releaseSupersededReply = resolve;
      });
      const supersededCommitted = new Promise<void>((resolve) => {
        supersededCommitObserved = resolve;
      });
      let createCount = 0;
      jest.spyOn(store, 'createJob').mockImplementation(async (...args) => {
        const created = await actualCreate(...args);
        createCount += 1;
        if (createCount === 1) {
          supersededCommitObserved();
          await supersededReplyGate;
          throw new JobCreationSupersededError(created);
        }
        return created;
      });
      const acknowledgeSpy = jest.spyOn(store, 'acknowledgeReplacedJobs');

      const supersededCreate = supersededManager.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      });
      await supersededCommitted;
      const currentCreate = manager.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      });
      await ownerPublishStarted;

      releaseSupersededReply();
      await expect(supersededCreate).rejects.toThrow('replaced during creation');
      expect(acknowledgeSpy).not.toHaveBeenCalled();

      releaseOwnerPublish();
      const current = await currentCreate;
      expect(current.createdAt).toBeGreaterThan(initial.createdAt);
      expect(await store.getJob(streamId)).toMatchObject({
        createdAt: current.createdAt,
        status: 'running',
      });
      expect(acknowledgeSpy).toHaveBeenCalledTimes(1);
    } finally {
      releaseOwnerPublish();
      await supersededManager.destroy();
    }
  });

  it('retires a local predecessor even when its confirmed handoff fails', async () => {
    await manager.destroy();
    store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    const transport = new InMemoryEventTransport() as InMemoryEventTransport & IEventTransport;
    transport.emitAbortConfirmed = jest
      .fn()
      .mockRejectedValue(new Error('simulated Redis abort publication failure'));
    transport.emitReplacedDoneConfirmed = jest
      .fn()
      .mockRejectedValue(new Error('simulated Redis terminal publication failure'));
    manager = new GenerationJobManagerClass();
    manager.configure({ jobStore: store, eventTransport: transport, isRedis: false });
    manager.initialize();

    const streamId = 'stream-failed-local-predecessor-handoff';
    const predecessor = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const onError = jest.fn();
    expect(await manager.subscribe(streamId, jest.fn(), jest.fn(), onError)).not.toBeNull();
    expect(predecessor.abortController.signal.aborted).toBe(false);

    await expect(
      manager.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      }),
    ).rejects.toThrow('predecessor handoff could not be confirmed');

    expect(predecessor.abortController.signal.aborted).toBe(true);
    expect(onError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
    expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
    expect(await store.getJob(streamId)).toMatchObject({
      status: 'error',
      error: 'Generation predecessor handoff could not be confirmed',
      finalEvent: expect.stringContaining('terminal_payload_missing'),
    });
  });

  it('closes a terminal predecessor with receipt-authorized DONE without aborting it', async () => {
    await manager.destroy();
    store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const transport = new InMemoryEventTransport() as InMemoryEventTransport & IEventTransport;
    transport.emitAbortConfirmed = jest.fn().mockResolvedValue(undefined);
    transport.emitReplacedDoneConfirmed = jest.fn().mockResolvedValue(undefined);
    manager = new GenerationJobManagerClass();
    manager.configure({ jobStore: store, eventTransport: transport, isRedis: false });
    manager.initialize();

    const streamId = 'stream-terminal-predecessor-receipt';
    const predecessor = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    expect(
      await store.transitionStatus(streamId, {
        from: 'running',
        to: 'complete',
        expectCreatedAt: predecessor.createdAt,
        patch: { completedAt: Date.now() },
      }),
    ).toBe(true);
    const acknowledgeSpy = jest.spyOn(store, 'acknowledgeReplacedJobs');

    const replacement = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });

    expect(transport.emitAbortConfirmed).not.toHaveBeenCalled();
    expect(transport.emitReplacedDoneConfirmed).toHaveBeenCalledWith(
      streamId,
      expect.objectContaining({
        final: true,
        reconcile: true,
        reconcileReason: 'generation_replaced',
        generationCreatedAt: predecessor.createdAt,
      }),
      predecessor.createdAt,
      expect.any(String),
    );
    expect(predecessor.abortController.signal.aborted).toBe(false);
    expect(replacement.abortController.signal.aborted).toBe(false);
    expect(acknowledgeSpy).toHaveBeenCalledTimes(1);
    expect(Object.getOwnPropertyDescriptor((await store.getJob(streamId))!, 'replacedJobs')).toBe(
      undefined,
    );
  });

  it('fails closed and retains the receipt when no remote owner acknowledges the abort', async () => {
    await manager.destroy();
    store = new InMemoryJobStore({ ttlAfterComplete: 60_000 });
    const transport = new InMemoryEventTransport() as InMemoryEventTransport & IEventTransport;
    transport.emitAbortConfirmed = jest.fn().mockResolvedValue(false);
    transport.emitReplacedDoneConfirmed = jest.fn().mockResolvedValue(undefined);
    manager = new GenerationJobManagerClass();
    manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
    manager.initialize();

    const streamId = 'stream-zero-listener-remote-handoff';
    const predecessor = await store.createJob(
      streamId,
      'user-1',
      streamId,
      undefined,
      { generationProtocolVersion: 2 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'remote-predecessor-attempt',
    );
    await store.updateJob(streamId, { providerAbortReady: true }, predecessor.createdAt);
    const acknowledgeSpy = jest.spyOn(store, 'acknowledgeReplacedJobs');

    await expect(
      manager.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      }),
    ).rejects.toThrow('predecessor handoff could not be confirmed');

    const durable = (await store.getJob(streamId)) as CreatedJobData;
    expect(durable).toMatchObject({
      status: 'error',
      error: 'Generation predecessor handoff could not be confirmed',
    });
    expect(durable.replacedJobs).toEqual([
      expect.objectContaining({ createdAt: predecessor.createdAt, status: 'running' }),
    ]);
    expect(acknowledgeSpy).not.toHaveBeenCalled();
  });

  it('self-fences a provider when a missed replacement abort makes its Redis append stale', async () => {
    await manager.destroy();
    store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: true,
    });
    manager.initialize();

    const streamId = 'stream-missed-abort-append-fence';
    const predecessor = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const onError = jest.fn();
    const subscription = await manager.subscribe(streamId, jest.fn(), jest.fn(), onError);
    expect(subscription).not.toBeNull();
    const replacement = await store.createJob(
      streamId,
      'user-1',
      streamId,
      undefined,
      { generationProtocolVersion: 2 },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'remote-replacement-attempt',
    );

    jest.useFakeTimers();
    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: 'stale provider output' },
      });
      await Promise.resolve();

      expect(predecessor.abortController.signal.aborted).toBe(true);
      expect(onError).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(REDIS_REPLACEMENT_HANDOFF_MAX_WAIT_MS);

      expect(onError).not.toHaveBeenCalled();
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(1);

      await jest.advanceTimersByTimeAsync(REDIS_EVENT_REORDER_TIMEOUT_MS * 2);

      expect(onError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
      expect(await store.getJob(streamId)).toMatchObject({
        createdAt: replacement.createdAt,
        status: 'running',
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('self-fences an ordinary provider when its Redis append rejects', async () => {
    await manager.destroy();
    store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: true,
    });
    manager.initialize();

    const streamId = 'stream-append-rejection-fence';
    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const onError = jest.fn();
    expect(await manager.subscribe(streamId, jest.fn(), jest.fn(), onError)).not.toBeNull();
    jest.spyOn(store, 'appendChunk').mockRejectedValueOnce(new Error('simulated Redis outage'));

    jest.useFakeTimers();
    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: 'uncoordinated provider output' },
      });
      await Promise.resolve();
      await Promise.resolve();

      expect(job.abortController.signal.aborted).toBe(true);
      expect(onError).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(REDIS_ABORT_TERMINAL_GRACE_MS);

      expect(onError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('self-fences when a chunk append wins but its active-only publication is fenced', async () => {
    await manager.destroy();
    store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    const transport = new InMemoryEventTransport();
    manager = new GenerationJobManagerClass();
    manager.configure({ jobStore: store, eventTransport: transport, isRedis: true });
    manager.initialize();

    const streamId = 'stream-publication-status-fence';
    const job = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const onError = jest.fn();
    expect(await manager.subscribe(streamId, jest.fn(), jest.fn(), onError)).not.toBeNull();
    registerChunkPublicationCapability(transport, async () => false);

    jest.useFakeTimers();
    try {
      await manager.emitChunk(streamId, {
        event: 'on_message_delta',
        data: { delta: 'publication lost its active-generation CAS' },
      });

      expect(job.abortController.signal.aborted).toBe(true);
      expect(onError).not.toHaveBeenCalled();

      await jest.advanceTimersByTimeAsync(REDIS_ABORT_TERMINAL_GRACE_MS);

      expect(onError).toHaveBeenCalledWith(TERMINAL_PUBLICATION_RECONNECT_ERROR);
      expect(manager.getRuntimeStats().runtimeStateSize).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not let a late stale-append result retire a newer local runtime', async () => {
    await manager.destroy();
    store = new InMemoryJobStore({ ttlAfterComplete: 0 });
    manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: store,
      eventTransport: new InMemoryEventTransport(),
      isRedis: true,
    });
    manager.initialize();

    const streamId = 'stream-late-append-fence';
    const predecessor = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    let settleAppend!: (appended: boolean) => void;
    const delayedAppend = new Promise<boolean>((resolve) => {
      settleAppend = resolve;
    });
    jest.spyOn(store, 'appendChunk').mockImplementationOnce(() => delayedAppend);
    const predecessorEmission = manager.emitChunk(streamId, {
      event: 'on_message_delta',
      data: { delta: 'in-flight predecessor output' },
    });
    await Promise.resolve();

    const replacement = await manager.createJob(streamId, 'user-1', streamId, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    expect(replacement.createdAt).toBeGreaterThan(predecessor.createdAt);
    expect(replacement.abortController.signal.aborted).toBe(false);

    settleAppend(false);
    await expect(predecessorEmission).rejects.toThrow('Durable chunk append was fenced out');
    await Promise.resolve();
    await Promise.resolve();

    expect(replacement.abortController.signal.aborted).toBe(false);
    expect(await manager.getJob(streamId)).toMatchObject({
      createdAt: replacement.createdAt,
      abortController: replacement.abortController,
    });
  });

  it('acknowledges predecessor receipts so ordinary stream reuse does not exhaust the chain cap', async () => {
    const streamId = 'stream-replacement-receipt-ack';
    let latestCreatedAt = 0;
    for (let index = 0; index < 40; index++) {
      const job = await manager.createJob(streamId, 'user-1', streamId, {
        initialMetadata: { generationProtocolVersion: 2 },
      });
      expect(job.createdAt).toBeGreaterThan(latestCreatedAt);
      latestCreatedAt = job.createdAt;
    }

    const durable = await store.getJob(streamId);
    expect(durable).toMatchObject({ createdAt: latestCreatedAt, status: 'running' });
    expect(Object.getOwnPropertyDescriptor(durable!, 'replacedJobs')).toBeUndefined();
  });

  it.each([
    { loseTerminalReply: false, replaced: false },
    { loseTerminalReply: true, replaced: false },
    { loseTerminalReply: true, replaced: true },
  ])(
    'announces only the exact recovered epoch (lost reply: $loseTerminalReply, replaced: $replaced)',
    async ({ loseTerminalReply, replaced }) => {
      const settled = jest.fn();
      manager.onGenerationSettled(settled);
      const transition = store.transitionStatus.bind(store);
      jest.spyOn(store, 'transitionStatus').mockImplementation(async (id, input) => {
        const committed = await transition(id, input);
        if (loseTerminalReply && input.to === 'error' && committed) {
          if (replaced) {
            const previous = await store.getJob(id);
            const replacement = await actualCreate(id, 'user-1', id);
            await transition(id, {
              from: 'running',
              to: 'error',
              expectCreatedAt: replacement.createdAt,
              patch: { error: previous?.error, finalEvent: previous?.finalEvent },
            });
          }
          throw new Error('lost terminal CAS reply');
        }
        return committed;
      });
      const streamId = 'stream-lost-create-legacy-failure';
      const clientRequestId = 'req-lost-create-legacy-failure';
      const claim = await manager.claimGeneration('user-1', clientRequestId, streamId, streamId, 2);
      const actualCreate = store.createJob.bind(store);
      jest.spyOn(store, 'createJob').mockImplementationOnce(async (...args) => {
        await actualCreate(...args);
        throw new Error('simulated lost atomic create reply');
      });
      const actualClaim = store.claimIdempotencyKey.bind(store);
      let failLegacyProbe = true;
      jest.spyOn(store, 'claimIdempotencyKey').mockImplementation((key, value, ttlSeconds) => {
        if (failLegacyProbe && key === `{user-1:${clientRequestId}}`) {
          failLegacyProbe = false;
          return Promise.reject(new Error('simulated legacy probe outage'));
        }
        return actualClaim(key, value, ttlSeconds);
      });

      await expect(
        manager.createJob(streamId, 'user-1', streamId, {
          idempotencyClientRequestId: clientRequestId,
          idempotencyClaimToken: claim.existing!.claimToken,
          initialMetadata: { generationProtocolVersion: 2 },
        }),
      ).rejects.toThrow('simulated lost atomic create reply');

      const durable = await store.getJob(streamId);
      expect(durable).toMatchObject({
        status: 'error',
        error: 'Generation idempotency rollout fence could not be recovered',
        finalEvent: expect.stringContaining('terminal_payload_missing'),
      });
      if (replaced) {
        expect(settled).not.toHaveBeenCalled();
        return;
      }
      expect(settled).toHaveBeenCalledTimes(1);
      expect(settled).toHaveBeenCalledWith({
        streamId,
        conversationId: streamId,
        userId: 'user-1',
        status: 'error',
      });
      const retry = await manager.claimGeneration('user-1', clientRequestId, streamId, streamId, 2);
      expect(retry).toMatchObject({
        claimed: false,
        existing: { startedAt: durable!.createdAt },
      });
      await expect(
        manager.takeoverGeneration('user-1', clientRequestId, streamId, retry.existing!),
      ).resolves.toMatchObject({ claimed: false });
    },
  );

  it('terminalizes and preserves the primary fence when the legacy started mark fails', async () => {
    const claim = await manager.claimGeneration(
      'user-1',
      'req-mark-failure',
      'stream-mark-failure',
      'stream-mark-failure',
      2,
    );
    jest.spyOn(store, 'markIdempotencyKeyStarted').mockResolvedValue(false);

    await expect(
      manager.createJob('stream-mark-failure', 'user-1', 'stream-mark-failure', {
        idempotencyClientRequestId: 'req-mark-failure',
        idempotencyClaimToken: claim.existing!.claimToken,
        initialMetadata: { generationProtocolVersion: 2 },
      }),
    ).rejects.toThrow('rollout fence could not be committed');
    expect(await store.getJob('stream-mark-failure')).toMatchObject({
      status: 'error',
      finalEvent: expect.stringContaining('terminal_payload_missing'),
    });

    await manager.releaseGeneration(
      'user-1',
      'req-mark-failure',
      'stream-mark-failure',
      claim.existing,
    );
    const primary = await store.claimIdempotencyKey(
      '{stream-mark-failure}:user-1:req-mark-failure',
      { streamId: 'wrong', conversationId: 'wrong' },
      60,
    );
    expect(primary).toMatchObject({
      claimed: false,
      existing: { claimToken: claim.existing!.claimToken, startedAt: expect.any(Number) },
    });
  });

  it('fails closed when primary and legacy token-bearing mirrors disagree', async () => {
    const claimedAt = Date.now();
    await store.claimIdempotencyKey(
      '{user-1:req-mismatch}',
      {
        streamId: 'stream-mismatch',
        conversationId: 'stream-mismatch',
        claimedAt,
        claimToken: 'legacy-token',
        generationProtocolVersion: 2,
      },
      1200,
    );
    await store.claimIdempotencyKey(
      '{stream-mismatch}:user-1:req-mismatch',
      {
        streamId: 'stream-mismatch',
        conversationId: 'stream-mismatch',
        claimedAt,
        claimToken: 'different-primary-token',
        generationProtocolVersion: 2,
      },
      1200,
    );

    await expect(
      manager.claimGeneration('user-1', 'req-mismatch', 'stream-mismatch', 'stream-mismatch', 2),
    ).rejects.toThrow('Mismatched legacy and primary');
  });

  it('does NOT dedup a distinct submission (e.g. regenerate reuses the user message id)', async () => {
    await manager.claimGeneration('user-1', 'req-1', 'stream-a', 'convo-a');
    // A regenerate is a fresh ask() → fresh clientRequestId, so it must start its own generation.
    const regenerate = await manager.claimGeneration('user-1', 'req-2', 'stream-a', 'convo-a');
    expect(regenerate).toEqual(
      expect.objectContaining({
        claimed: true,
        existing: expect.objectContaining({ claimToken: expect.any(String) }),
      }),
    );
  });

  it('scopes claims per user', async () => {
    await manager.claimGeneration('user-1', 'req-1', 'stream-a', 'convo-a');
    const otherUser = await manager.claimGeneration('user-2', 'req-1', 'stream-z', 'convo-z');
    expect(otherUser).toEqual(
      expect.objectContaining({
        claimed: true,
        existing: expect.objectContaining({ claimToken: expect.any(String) }),
      }),
    );
  });

  it('allows a fresh claim after release', async () => {
    const first = await manager.claimGeneration('user-1', 'req-1', 'stream-a', 'convo-a');
    await manager.releaseGeneration('user-1', 'req-1', 'stream-a', first.existing);
    const again = await manager.claimGeneration('user-1', 'req-1', 'stream-a', 'convo-a');
    expect(again).toEqual(
      expect.objectContaining({
        claimed: true,
        existing: expect.objectContaining({ claimToken: expect.any(String) }),
      }),
    );
  });

  it('atomically fences an abandoned pre-create owner during takeover', async () => {
    const original = await manager.claimGeneration('user-1', 'req-1', 'stream-a', 'convo-a');
    expect(original.existing).toBeDefined();

    const takeover = await manager.takeoverGeneration(
      'user-1',
      'req-1',
      'stream-a',
      original.existing!,
    );
    expect(takeover).toEqual(
      expect.objectContaining({
        claimed: true,
        existing: expect.objectContaining({
          streamId: 'stream-a',
          claimToken: expect.any(String),
        }),
      }),
    );
    expect(takeover.existing?.claimToken).not.toBe(original.existing?.claimToken);

    await expect(
      manager.createJob('stream-a', 'user-1', 'convo-a', {
        idempotencyClientRequestId: 'req-1',
        idempotencyClaimToken: original.existing!.claimToken,
      }),
    ).rejects.toThrow('claim was taken over');

    await expect(
      manager.createJob('stream-a', 'user-1', 'convo-a', {
        idempotencyClientRequestId: 'req-1',
        idempotencyClaimToken: takeover.existing!.claimToken,
      }),
    ).resolves.toEqual(expect.objectContaining({ streamId: 'stream-a' }));
  });

  it('rolls back the newly-taken primary if the legacy takeover loses', async () => {
    const original = await manager.claimGeneration(
      'user-1',
      'req-rollback',
      'stream-rollback',
      'stream-rollback',
      2,
    );
    const actualTakeover = store.takeoverIdempotencyKey.bind(store);
    jest
      .spyOn(store, 'takeoverIdempotencyKey')
      .mockImplementation((key, expected, value, ttlSeconds) =>
        key === '{user-1:req-rollback}'
          ? Promise.resolve(false)
          : actualTakeover(key, expected, value, ttlSeconds),
      );

    const takeover = await manager.takeoverGeneration(
      'user-1',
      'req-rollback',
      'stream-rollback',
      original.existing!,
    );
    expect(takeover).toEqual({ claimed: false, source: 'primary' });

    const primaryAfterRollback = await store.claimIdempotencyKey(
      '{stream-rollback}:user-1:req-rollback',
      original.existing!,
      1200,
    );
    expect(primaryAfterRollback.claimed).toBe(true);
    const legacy = await store.claimIdempotencyKey(
      '{user-1:req-rollback}',
      { streamId: 'wrong', conversationId: 'wrong' },
      1200,
    );
    expect(legacy.existing?.claimToken).toBe(original.existing?.claimToken);
  });

  it('finishes a primary takeover whose committed reply was lost', async () => {
    jest.useFakeTimers();
    try {
      const originalTime = new Date('2026-07-20T00:00:00Z');
      jest.setSystemTime(originalTime);
      const original = await manager.claimGeneration(
        'user-1',
        'req-lost-takeover-reply',
        'stream-lost-takeover-reply',
        'stream-lost-takeover-reply',
        2,
      );
      const actualTakeover = store.takeoverIdempotencyKey.bind(store);
      let injectLostReply = true;
      jest
        .spyOn(store, 'takeoverIdempotencyKey')
        .mockImplementation(async (key, expected, value, ttlSeconds) => {
          const result = await actualTakeover(key, expected, value, ttlSeconds);
          if (
            injectLostReply &&
            key === '{stream-lost-takeover-reply}:user-1:req-lost-takeover-reply'
          ) {
            injectLostReply = false;
            throw new Error('simulated lost primary CAS reply');
          }
          return result;
        });

      // A node clock may step backward between the original claim and its
      // takeover. Lineage recovery must not reject that legitimate CAS split.
      jest.setSystemTime(new Date(originalTime.getTime() - 60_000));
      const takeover = await manager.takeoverGeneration(
        'user-1',
        'req-lost-takeover-reply',
        'stream-lost-takeover-reply',
        original.existing!,
      );
      expect(takeover).toMatchObject({
        claimed: true,
        source: 'primary',
        existing: {
          previousClaimToken: original.existing!.claimToken,
          claimToken: expect.any(String),
        },
      });
      expect(takeover.existing!.claimedAt).toBeGreaterThanOrEqual(original.existing!.claimedAt!);
      const retry = await manager.claimGeneration(
        'user-1',
        'req-lost-takeover-reply',
        'stream-lost-takeover-reply',
        'stream-lost-takeover-reply',
        2,
      );
      expect(retry).toMatchObject({
        claimed: false,
        existing: { claimToken: takeover.existing!.claimToken },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('repairs only a lineage-proven unstarted takeover split', async () => {
    const original = await manager.claimGeneration(
      'user-1',
      'req-split-repair',
      'stream-split-repair',
      'stream-split-repair',
      2,
    );
    const splitPrimary = {
      ...original.existing!,
      claimedAt: original.existing!.claimedAt! + 1,
      claimToken: 'split-primary-token',
      previousClaimToken: original.existing!.claimToken,
    };
    expect(
      await store.takeoverIdempotencyKey(
        '{stream-split-repair}:user-1:req-split-repair',
        original.existing!,
        splitPrimary,
        1200,
      ),
    ).toBe(true);

    const repaired = await manager.claimGeneration(
      'user-1',
      'req-split-repair',
      'stream-split-repair',
      'stream-split-repair',
      2,
    );
    expect(repaired).toMatchObject({
      claimed: false,
      existing: { claimToken: 'split-primary-token' },
    });
    const legacy = await store.claimIdempotencyKey(
      '{user-1:req-split-repair}',
      original.existing!,
      1200,
    );
    expect(legacy.existing).toEqual(splitPrimary);
  });

  it('never takes over a claim already marked started with job creation', async () => {
    const original = await manager.claimGeneration('user-1', 'req-1', 'stream-a', 'convo-a');
    await manager.createJob('stream-a', 'user-1', 'convo-a', {
      idempotencyClientRequestId: 'req-1',
      idempotencyClaimToken: original.existing!.claimToken,
    });

    const takeover = await manager.takeoverGeneration(
      'user-1',
      'req-1',
      'stream-a',
      original.existing!,
    );
    expect(takeover).toEqual(
      expect.objectContaining({
        claimed: false,
        source: 'primary',
        existing: expect.objectContaining({ startedAt: expect.any(Number) }),
      }),
    );
  });

  it('does not release either started tombstone with a stale pre-create value', async () => {
    const original = await manager.claimGeneration(
      'user-1',
      'req-release-started',
      'stream-release-started',
      'stream-release-started',
      2,
    );
    const job = await manager.createJob(
      'stream-release-started',
      'user-1',
      'stream-release-started',
      {
        idempotencyClientRequestId: 'req-release-started',
        idempotencyClaimToken: original.existing!.claimToken,
        initialMetadata: { generationProtocolVersion: 2 },
      },
    );

    await manager.releaseGeneration(
      'user-1',
      'req-release-started',
      'stream-release-started',
      original.existing,
    );
    for (const key of [
      '{user-1:req-release-started}',
      '{stream-release-started}:user-1:req-release-started',
    ]) {
      const stored = await store.claimIdempotencyKey(
        key,
        { streamId: 'wrong', conversationId: 'wrong' },
        60,
      );
      expect(stored.existing).toMatchObject({
        claimToken: original.existing!.claimToken,
        startedAt: job.createdAt,
      });
    }
  });

  it('tombstones an uncorrelated v1 legacy job before 503 so deletion cannot enable takeover', async () => {
    const job = await manager.createJob('stream-legacy-live', 'user-1', 'stream-legacy-live', {
      initialMetadata: { generationProtocolVersion: 1 },
    });
    const reacquired = await manager.claimGeneration(
      'user-1',
      'req-legacy-expired',
      'stream-legacy-live',
      'stream-legacy-live',
      2,
    );
    expect(reacquired.claimed).toBe(true);

    await expect(
      manager.resumeClaimedGeneration(
        'user-1',
        'req-legacy-expired',
        'stream-legacy-live',
        reacquired.existing!,
      ),
    ).rejects.toThrow('conservatively fenced');

    for (const key of [
      '{user-1:req-legacy-expired}',
      '{stream-legacy-live}:user-1:req-legacy-expired',
    ]) {
      const stored = await store.claimIdempotencyKey(key, reacquired.existing!, 60);
      expect(stored.existing).toMatchObject({
        claimToken: reacquired.existing!.claimToken,
        startedAt: job.createdAt,
        generationProtocolVersion: 1,
      });
    }

    expect(await store.deleteJob('stream-legacy-live', job.createdAt)).toBe(true);
    const retry = await manager.claimGeneration(
      'user-1',
      'req-legacy-expired',
      'stream-legacy-live',
      'stream-legacy-live',
      2,
    );
    expect(retry).toMatchObject({
      claimed: false,
      existing: { startedAt: job.createdAt, generationProtocolVersion: 1 },
    });
    await expect(
      manager.takeoverGeneration(
        'user-1',
        'req-legacy-expired',
        'stream-legacy-live',
        retry.existing!,
      ),
    ).resolves.toMatchObject({ claimed: false });
    await expect(
      manager.createJob('stream-legacy-live', 'user-1', 'stream-legacy-live', {
        idempotencyClientRequestId: 'req-legacy-expired',
        idempotencyClaimToken: reacquired.existing!.claimToken,
        initialMetadata: { generationProtocolVersion: 2 },
      }),
    ).rejects.toThrow('claim was taken over');
  });

  it.each([
    { jobProtocol: 1 as const, retryProtocol: 2 as const },
    { jobProtocol: 2 as const, retryProtocol: 1 as const },
  ])(
    'adopts a correlated v$jobProtocol job with a v$retryProtocol fresh claim to the immutable job protocol',
    async ({ jobProtocol, retryProtocol }) => {
      const suffix = `${jobProtocol}-${retryProtocol}`;
      const streamId = `stream-protocol-adopt-${suffix}`;
      const clientRequestId = `req-protocol-adopt-${suffix}`;
      const original = await manager.claimGeneration(
        'user-1',
        clientRequestId,
        streamId,
        streamId,
        jobProtocol,
      );
      const job = await manager.createJob(streamId, 'user-1', streamId, {
        idempotencyClientRequestId: clientRequestId,
        idempotencyClaimToken: original.existing!.claimToken,
        initialMetadata: { generationProtocolVersion: jobProtocol },
      });
      await store.releaseIdempotencyKey(
        `{${streamId}}:user-1:${clientRequestId}`,
        original.existing,
      );
      await store.releaseIdempotencyKey(`{user-1:${clientRequestId}}`, original.existing);

      const fresh = await manager.claimGeneration(
        'user-1',
        clientRequestId,
        streamId,
        streamId,
        retryProtocol,
      );
      expect(fresh.claimed).toBe(true);
      const resumed = await manager.resumeClaimedGeneration(
        'user-1',
        clientRequestId,
        streamId,
        fresh.existing!,
      );
      expect(resumed).toMatchObject({
        startedAt: job.createdAt,
        generationProtocolVersion: jobProtocol,
      });

      expect(await store.deleteJob(streamId, job.createdAt)).toBe(true);
      const retry = await manager.claimGeneration(
        'user-1',
        clientRequestId,
        streamId,
        streamId,
        retryProtocol,
      );
      expect(retry).toMatchObject({
        claimed: false,
        existing: { startedAt: job.createdAt, generationProtocolVersion: jobProtocol },
      });
      await expect(
        manager.takeoverGeneration('user-1', clientRequestId, streamId, retry.existing!),
      ).resolves.toMatchObject({ claimed: false });
    },
  );

  it('tombstones a fresh claim when terminal deletion wins the live-adoption race', async () => {
    jest.useFakeTimers();
    try {
      const startedAt = new Date('2026-07-20T00:00:00Z');
      jest.setSystemTime(startedAt);
      const streamId = 'stream-terminal-adopt-race';
      const clientRequestId = 'req-terminal-adopt-race';
      const original = await manager.claimGeneration(
        'user-1',
        clientRequestId,
        streamId,
        streamId,
        2,
      );
      const job = await manager.createJob(streamId, 'user-1', streamId, {
        idempotencyClientRequestId: clientRequestId,
        idempotencyClaimToken: original.existing!.claimToken,
        initialMetadata: { generationProtocolVersion: 2 },
      });

      // Both mirrors have naturally expired, while a custom long-running job
      // is still active and exactly correlated to this request.
      jest.setSystemTime(new Date(startedAt.getTime() + 27 * 60 * 60 * 1000));
      const fresh = await manager.claimGeneration('user-1', clientRequestId, streamId, streamId, 2);
      expect(fresh.claimed).toBe(true);

      jest.spyOn(store, 'adoptIdempotencyKeyForJob').mockImplementation(async () => {
        expect(
          await store.transitionStatus(streamId, {
            from: 'running',
            to: 'complete',
            expectCreatedAt: job.createdAt,
          }),
        ).toBe(true);
        expect(await store.deleteJob(streamId, job.createdAt)).toBe(true);
        return false;
      });

      await expect(
        manager.resumeClaimedGeneration('user-1', clientRequestId, streamId, fresh.existing!),
      ).rejects.toThrow('conservatively fenced');

      for (const key of [
        `{user-1:${clientRequestId}}`,
        `{${streamId}}:user-1:${clientRequestId}`,
      ]) {
        const stored = await store.claimIdempotencyKey(key, fresh.existing!, 60);
        expect(stored).toMatchObject({
          claimed: false,
          existing: {
            claimToken: fresh.existing!.claimToken,
            startedAt: job.createdAt,
            generationProtocolVersion: 2,
          },
        });
      }

      const retry = await manager.claimGeneration('user-1', clientRequestId, streamId, streamId, 2);
      expect(retry).toMatchObject({
        claimed: false,
        existing: { startedAt: job.createdAt },
      });
      await expect(
        manager.takeoverGeneration('user-1', clientRequestId, streamId, retry.existing!),
      ).resolves.toMatchObject({ claimed: false });
    } finally {
      jest.useRealTimers();
    }
  });

  it('adopts an expired lease for the same live paused generation instead of replacing it', async () => {
    jest.useFakeTimers();
    try {
      const startedAt = new Date('2026-07-20T00:00:00Z');
      jest.setSystemTime(startedAt);
      const original = await manager.claimGeneration('user-1', 'req-1', 'stream-a', 'convo-a', 2);
      const job = await manager.createJob('stream-a', 'user-1', 'convo-a', {
        idempotencyClientRequestId: 'req-1',
        idempotencyClaimToken: original.existing!.claimToken,
        initialMetadata: { generationProtocolVersion: 2 },
      });
      const action = buildPendingAction(
        buildToolApprovalPayload([
          { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call-1' },
        ]),
        {
          streamId: 'stream-a',
          conversationId: 'convo-a',
          runId: 'run-1',
          responseMessageId: 'message-1',
        },
      );
      expect(await manager.approvals.pause('stream-a', action)).toBe(true);

      jest.setSystemTime(new Date(startedAt.getTime() + 26 * 60 * 60 * 1000));
      const reacquired = await manager.claimGeneration('user-1', 'req-1', 'stream-a', 'convo-a', 2);
      expect(reacquired.claimed).toBe(true);

      const resumed = await manager.resumeClaimedGeneration(
        'user-1',
        'req-1',
        'stream-a',
        reacquired.existing!,
      );
      expect(resumed).toEqual(
        expect.objectContaining({
          streamId: 'stream-a',
          conversationId: 'convo-a',
          startedAt: job.createdAt,
        }),
      );
      const retry = await manager.claimGeneration('user-1', 'req-1', 'stream-a', 'convo-a', 2);
      expect(retry).toEqual(
        expect.objectContaining({
          claimed: false,
          existing: expect.objectContaining({ startedAt: job.createdAt }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
