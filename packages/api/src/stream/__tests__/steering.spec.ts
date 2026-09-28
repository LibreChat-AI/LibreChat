import { logger } from '@librechat/data-schemas';
import { SteerEvents } from 'librechat-data-provider';
import type { TMessageContentParts, TPendingSteer, Agents } from 'librechat-data-provider';
import type {
  SteerQueueItem,
  IEventTransport,
  PreemptMessage,
} from '~/stream/interfaces/IJobStore';
import type { ResumeState, ServerSentEvent } from '~/types';
import {
  STEER_ENQUEUE_NOT_RUNNING,
  STEER_ENQUEUE_QUEUE_FULL,
  STEER_QUEUE_MAX_DEPTH,
} from '~/stream/interfaces/IJobStore';
import { PARKED_STEERS_TTL_MS, InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { synthesizeAppliedSteerEvents, toPendingSteer } from '~/stream/SteeringLifecycle';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { buildPendingAction, buildToolApprovalPayload } from '~/agents/hitl/policy';
import { GenerationJobManagerClass } from '~/stream/GenerationJobManager';

jest.spyOn(console, 'log').mockImplementation();

describe('SteeringLifecycle via GenerationJobManager.steering (in-memory)', () => {
  let manager: GenerationJobManagerClass;
  let jobStore: InMemoryJobStore;

  beforeEach(() => {
    manager = new GenerationJobManagerClass();
    jobStore = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    manager.configure({
      jobStore,
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  let steerCounter = 0;
  function buildSteer(text: string, userId = 'user-1'): SteerQueueItem {
    steerCounter += 1;
    return {
      steerId: `steer-${steerCounter}`,
      text,
      userId,
      createdAt: Date.now(),
    };
  }

  describe('toPendingSteer', () => {
    test('keeps quotes in the client-safe projection while dropping userId', () => {
      const projected = toPendingSteer({
        ...buildSteer('with context'),
        quotes: ['the excerpt'],
      });
      expect(projected.quotes).toEqual(['the excerpt']);
      expect(projected).not.toHaveProperty('userId');
    });
  });

  describe('enqueue', () => {
    test('appends to a running job and returns the queue depth', async () => {
      const streamId = 'steer-enqueue';
      await manager.createJob(streamId, 'user-1');

      expect(await manager.steering.enqueue(streamId, buildSteer('one'))).toBe(1);
      expect(await manager.steering.enqueue(streamId, buildSteer('two'))).toBe(2);
    });

    /**
     * The steer route decides capability against a job it read several awaits
     * earlier. If the run is replaced in between, an unfenced enqueue puts the
     * item on the REPLACEMENT queue while the preempt flag and the arm still
     * name the previous epoch — so the arm is fenced out at the owner and the
     * 202 promises an interrupt that cannot happen. Rejecting is the honest
     * outcome: the run the caller was told about is gone.
     */
    test('refuses an item fenced to a generation that has been replaced', async () => {
      const streamId = 'steer-enqueue-fenced';
      const first = await manager.createJob(streamId, 'user-1');
      const replacement = await manager.createJob(streamId, 'user-1');
      expect(replacement.createdAt).not.toBe(first.createdAt);

      expect(await manager.steering.enqueue(streamId, buildSteer('stale'), first.createdAt)).toBe(
        STEER_ENQUEUE_NOT_RUNNING,
      );
      expect(await manager.steering.peek(streamId)).toEqual([]);

      expect(
        await manager.steering.enqueue(streamId, buildSteer('live'), replacement.createdAt),
      ).toBe(1);
    });

    test('rejects when the job does not exist', async () => {
      expect(await manager.steering.enqueue('nonexistent', buildSteer('x'))).toBe(
        STEER_ENQUEUE_NOT_RUNNING,
      );
    });

    test('rejects when the job is paused for human review', async () => {
      const streamId = 'steer-paused';
      await manager.createJob(streamId, 'user-1');
      const payload = buildToolApprovalPayload([
        { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call_abc' },
      ]);
      const action = buildPendingAction(payload, {
        streamId,
        conversationId: streamId,
        runId: 'run-1',
        responseMessageId: 'msg-1',
      });
      expect(await manager.approvals.pause(streamId, action)).toBe(true);

      expect(await manager.steering.enqueue(streamId, buildSteer('late'))).toBe(
        STEER_ENQUEUE_NOT_RUNNING,
      );
    });

    test('rejects when the job is terminal', async () => {
      const streamId = 'steer-terminal';
      await manager.createJob(streamId, 'user-1');
      await manager.completeJob(streamId, 'boom');

      expect(await manager.steering.enqueue(streamId, buildSteer('late'))).toBe(
        STEER_ENQUEUE_NOT_RUNNING,
      );
    });

    test('rejects past the max queue depth', async () => {
      const streamId = 'steer-full';
      await manager.createJob(streamId, 'user-1');

      for (let i = 0; i < STEER_QUEUE_MAX_DEPTH; i++) {
        expect(await manager.steering.enqueue(streamId, buildSteer(`s${i}`))).toBe(i + 1);
      }
      expect(await manager.steering.enqueue(streamId, buildSteer('overflow'))).toBe(
        STEER_ENQUEUE_QUEUE_FULL,
      );
    });
  });

  describe('drain / peek', () => {
    test('drain takes all items FIFO and empties the queue', async () => {
      const streamId = 'steer-drain';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.enqueue(streamId, buildSteer('first'));
      await manager.steering.enqueue(streamId, buildSteer('second'));

      const drained = await manager.steering.drain(streamId);
      expect(drained.map((s) => s.text)).toEqual(['first', 'second']);
      expect(await manager.steering.drain(streamId)).toEqual([]);
    });

    test('destroy clears claimed steer state as well as the live queue', async () => {
      const streamId = 'steer-destroy-claimed';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.enqueue(streamId, buildSteer('claimed before destroy'));
      await manager.steering.drain(streamId);
      expect(await jobStore.peekClaimedSteers(streamId)).toHaveLength(1);

      await jobStore.destroy();

      expect(await jobStore.peekClaimedSteers(streamId)).toEqual([]);
    });

    test('peek is non-destructive', async () => {
      const streamId = 'steer-peek';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.enqueue(streamId, buildSteer('kept'));

      expect((await manager.steering.peek(streamId)).map((s) => s.text)).toEqual(['kept']);
      expect((await manager.steering.peek(streamId)).map((s) => s.text)).toEqual(['kept']);
      expect((await manager.steering.drain(streamId)).map((s) => s.text)).toEqual(['kept']);
    });

    test('drain with a stale expectedCreatedAt refuses and preserves the queue', async () => {
      const streamId = 'steer-drain-stale';
      const job = await manager.createJob(streamId, 'user-1');
      await manager.steering.enqueue(streamId, buildSteer('kept for the live run'));

      expect(await manager.steering.drain(streamId, job.createdAt - 1)).toEqual([]);
      expect((await manager.steering.peek(streamId)).map((s) => s.text)).toEqual([
        'kept for the live run',
      ]);
      expect((await manager.steering.drain(streamId, job.createdAt)).map((s) => s.text)).toEqual([
        'kept for the live run',
      ]);
    });

    test('peek with a stale expectedCreatedAt hides and preserves the live queue', async () => {
      const streamId = 'steer-peek-stale';
      const job = await manager.createJob(streamId, 'user-1');
      await manager.steering.enqueue(streamId, buildSteer('kept for the live run'));

      expect(await manager.steering.peek(streamId, job.createdAt - 1)).toEqual([]);
      expect((await manager.steering.peek(streamId, job.createdAt)).map((s) => s.text)).toEqual([
        'kept for the live run',
      ]);
    });
  });

  describe('terminal claim-or-seal', () => {
    test('claims a v2 FIFO batch without closing admission', async () => {
      const streamId = 'steer-terminal-claim';
      const job = await manager.createJob(streamId, 'user-1');
      const first = buildSteer('first');
      const second = buildSteer('second');
      await manager.steering.enqueue(streamId, first, job.createdAt);
      await manager.steering.enqueue(streamId, second, job.createdAt);

      await expect(
        manager.steering.admitTerminal(
          streamId,
          { allowClaim: true, keepOpenWhenEmpty: false },
          job.createdAt,
        ),
      ).resolves.toEqual({ outcome: 'claimed', items: [first, second] });
      await expect(jobStore.peekClaimedSteers(streamId, job.createdAt)).resolves.toEqual([
        first,
        second,
      ]);
      await expect(
        manager.steering.enqueue(streamId, buildSteer('later'), job.createdAt),
      ).resolves.toBe(1);
    });

    test.each([
      { name: 'empty queue', queued: false, allowClaim: true },
      { name: 'exhausted budget', queued: true, allowClaim: false },
    ])('seals admission for $name', async ({ queued, allowClaim }) => {
      const streamId = `steer-terminal-seal-${queued}-${allowClaim}`;
      const job = await manager.createJob(streamId, 'user-1');
      const existing = buildSteer('existing');
      if (queued) {
        await manager.steering.enqueue(streamId, existing, job.createdAt);
      }

      await expect(
        manager.steering.admitTerminal(
          streamId,
          { allowClaim, keepOpenWhenEmpty: false },
          job.createdAt,
        ),
      ).resolves.toEqual({ outcome: 'sealed' });
      await expect(
        manager.steering.enqueue(streamId, buildSteer('raced'), job.createdAt),
      ).resolves.toBe(STEER_ENQUEUE_NOT_RUNNING);
      await expect(manager.steering.closeAndDrain(streamId, job.createdAt)).resolves.toEqual(
        queued ? [existing] : [],
      );
    });

    test('refuses a stale generation without sealing its replacement', async () => {
      const streamId = 'steer-terminal-stale';
      const stale = await manager.createJob(streamId, 'user-1');
      const replacement = await manager.createJob(streamId, 'user-1');

      await expect(
        manager.steering.admitTerminal(
          streamId,
          { allowClaim: true, keepOpenWhenEmpty: false },
          stale.createdAt,
        ),
      ).resolves.toEqual({ outcome: 'unavailable' });
      await expect(
        manager.steering.enqueue(streamId, buildSteer('replacement'), replacement.createdAt),
      ).resolves.toBe(1);
    });

    test('seals protocol v1 instead of claiming an unrecoverable batch', async () => {
      const streamId = 'steer-terminal-v1';
      const job = await manager.createJob(streamId, 'user-1', undefined, {
        initialMetadata: { generationProtocolVersion: 1 },
      });
      const queued = buildSteer('legacy');
      await manager.steering.enqueue(streamId, queued, job.createdAt);

      await expect(
        manager.steering.admitTerminal(
          streamId,
          { allowClaim: true, keepOpenWhenEmpty: false },
          job.createdAt,
        ),
      ).resolves.toEqual({ outcome: 'sealed' });
      await expect(manager.steering.closeAndDrain(streamId, job.createdAt)).resolves.toEqual([
        queued,
      ]);
    });

    test('keeps an empty queue open while another continuation is already planned', async () => {
      const streamId = 'steer-terminal-open';
      const job = await manager.createJob(streamId, 'user-1');

      await expect(
        manager.steering.admitTerminal(
          streamId,
          { allowClaim: true, keepOpenWhenEmpty: true },
          job.createdAt,
        ),
      ).resolves.toEqual({ outcome: 'open' });
      await expect(
        manager.steering.enqueue(streamId, buildSteer('planned continuation'), job.createdAt),
      ).resolves.toBe(1);
    });
  });

  describe('cancel', () => {
    test('removes exactly the cancelled steer and preserves queue order', async () => {
      const streamId = 'steer-cancel';
      await manager.createJob(streamId, 'user-1');
      const first = buildSteer('first');
      const second = buildSteer('second');
      await manager.steering.enqueue(streamId, first);
      await manager.steering.enqueue(streamId, second);

      expect(await manager.steering.cancel(streamId, first.steerId)).toBe(true);
      expect((await manager.steering.peek(streamId)).map((s) => s.text)).toEqual(['second']);
    });

    test('returns false when the steer already left the queue', async () => {
      const streamId = 'steer-cancel-late';
      await manager.createJob(streamId, 'user-1');
      const steer = buildSteer('drained before cancel');
      await manager.steering.enqueue(streamId, steer);
      await manager.steering.drain(streamId);

      expect(await manager.steering.cancel(streamId, steer.steerId)).toBe(false);
      expect(await manager.steering.cancel('nonexistent', steer.steerId)).toBe(false);
    });

    test('a cancel authorized for generation A cannot remove generation B state', async () => {
      const streamId = 'steer-cancel-replaced';
      const predecessor = await manager.createJob(streamId, 'user-1');
      const reusedId = buildSteer('predecessor');
      await manager.steering.enqueue(streamId, reusedId, predecessor.createdAt);

      const replacement = await manager.createJob(streamId, 'user-1');
      const replacementItem = { ...buildSteer('replacement'), steerId: reusedId.steerId };
      await manager.steering.enqueue(streamId, replacementItem, replacement.createdAt);

      await expect(
        manager.steering.cancel(streamId, reusedId.steerId, predecessor.createdAt),
      ).resolves.toBe(false);
      await expect(manager.steering.peek(streamId, replacement.createdAt)).resolves.toEqual([
        replacementItem,
      ]);
    });
  });

  describe('closeAndDrain', () => {
    test('takes all items and rejects later enqueues until the stream id is reused', async () => {
      const streamId = 'steer-close';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.enqueue(streamId, buildSteer('drained'));

      const drained = await manager.steering.closeAndDrain(streamId);
      expect(drained.map((s) => s.text)).toEqual(['drained']);

      // The job is still `running`, but the queue is closed — a steer racing
      // finalization must be rejected, not ACKed and then silently cleared.
      expect(await manager.steering.enqueue(streamId, buildSteer('raced'))).toBe(
        STEER_ENQUEUE_NOT_RUNNING,
      );

      // A replacement job on the same stream id reopens the channel.
      await manager.createJob(streamId, 'user-1');
      expect(await manager.steering.enqueue(streamId, buildSteer('fresh'))).toBe(1);
    });

    test('createJob clears steers inherited from a replaced job', async () => {
      const streamId = 'steer-replace';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.enqueue(streamId, buildSteer('old run steer'));

      await manager.createJob(streamId, 'user-1');
      expect(await manager.steering.peek(streamId)).toEqual([]);
    });

    test('a stale run cannot close or steal a replacement queue', async () => {
      const streamId = 'steer-close-stale';
      const oldJob = await manager.createJob(streamId, 'user-1');
      // Distinct createdAt: replacement in the same millisecond is
      // indistinguishable by design (the guard keys on creation time).
      await new Promise((resolve) => setTimeout(resolve, 2));
      const newJob = await manager.createJob(streamId, 'user-1');
      await manager.steering.enqueue(streamId, buildSteer('belongs to the new run'));

      // Old run finalizes late: guarded close must neither drain nor close.
      expect(await manager.steering.closeAndDrain(streamId, oldJob.createdAt)).toEqual([]);
      expect((await manager.steering.peek(streamId)).map((s) => s.text)).toEqual([
        'belongs to the new run',
      ]);
      expect(await manager.steering.enqueue(streamId, buildSteer('still open'))).toBe(2);

      expect(
        (await manager.steering.closeAndDrain(streamId, newJob.createdAt)).map((s) => s.text),
      ).toEqual(['belongs to the new run', 'still open']);
    });
  });

  describe('execution-bound quote capability', () => {
    function pauseAction(streamId: string) {
      const payload = buildToolApprovalPayload([
        { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call_qc' },
      ]);
      return buildPendingAction(payload, {
        streamId,
        conversationId: streamId,
        runId: 'run-qc',
        responseMessageId: 'msg-qc',
      });
    }

    test('a capable resume re-binds the marker to its own execution', async () => {
      const streamId = 'steer-quote-capability-resume';
      const job = await manager.createJob(streamId, 'user-1', undefined, {
        initialMetadata: { steerQuotesCapable: true },
      });
      expect(await manager.approvals.pause(streamId, pauseAction(streamId))).toBe(true);

      expect(
        await manager.approvals.resolve(
          streamId,
          undefined,
          { steerQuotesCapable: true, providerExecutionId: 'resumed-exec', providerDrained: true },
          job.createdAt,
        ),
      ).toBe(true);

      const resumed = await manager.getJob(streamId);
      expect(resumed?.metadata.steerQuotesExecutionId).toBe('resumed-exec');
      const depth = await manager.steering.enqueue(streamId, {
        ...buildSteer('quoted after resume'),
        quotes: ['kept excerpt'],
      });
      expect(depth).toBe(1);
      const [queued] = await manager.steering.peek(streamId);
      expect(queued.quotes).toEqual(['kept excerpt']);
    });

    test('a legacy resume (no assertion) invalidates the previous marker atomically', async () => {
      const streamId = 'steer-quote-capability-legacy-resume';
      const job = await manager.createJob(streamId, 'user-1', undefined, {
        initialMetadata: { steerQuotesCapable: true },
      });
      expect(await manager.approvals.pause(streamId, pauseAction(streamId))).toBe(true);

      // A pre-quotes replica's patch rewrites the execution id but cannot
      // know the marker field — exactly the omit-not-clear shape.
      expect(
        await manager.approvals.resolve(
          streamId,
          undefined,
          { providerExecutionId: 'legacy-exec', providerDrained: true },
          job.createdAt,
        ),
      ).toBe(true);

      await manager.steering.enqueue(streamId, {
        ...buildSteer('quoted after legacy resume'),
        quotes: ['dropped excerpt'],
      });
      const [queued] = await manager.steering.peek(streamId);
      expect(queued).not.toHaveProperty('quotes');
    });
  });

  describe('recovered-steer payload proof', () => {
    const { buildRecoveredSteerPayload, recoveredSteerPayloadMatches } =
      jest.requireActual<typeof import('~/stream/SteerRecovery')>('~/stream/SteerRecovery');

    test('binds normalized quotes into the proof (empty when none)', () => {
      expect(buildRecoveredSteerPayload('words', undefined)).toEqual({
        text: 'words',
        fileIds: [],
        quotes: [],
      });
      expect(buildRecoveredSteerPayload('words', undefined, ['  kept  ', ''])).toEqual({
        text: 'words',
        fileIds: [],
        quotes: ['kept'],
      });
    });

    test('a recovery matches only when the quotes match, order-significant', () => {
      const item = { text: 'words', quotes: ['first', 'second'] };
      const proofFor = (quotes?: unknown) => buildRecoveredSteerPayload('words', undefined, quotes);
      expect(recoveredSteerPayloadMatches(item, proofFor(['first', 'second'])!)).toBe(true);
      expect(recoveredSteerPayloadMatches(item, proofFor(['second', 'first'])!)).toBe(false);
      expect(recoveredSteerPayloadMatches(item, proofFor(['first'])!)).toBe(false);
      // A stale client omitting the quotes must not consume the parked source.
      expect(recoveredSteerPayloadMatches(item, proofFor(undefined)!)).toBe(false);
      // Quote-less sources keep matching quote-less recoveries (pre-quotes parity).
      expect(recoveredSteerPayloadMatches({ text: 'words' }, proofFor(undefined)!)).toBe(true);
    });
  });

  describe('park / claim (no-subscriber recovery)', () => {
    const owner = { userId: 'user-1' };

    test('parked leftovers remain replayable until exact recovery starts', async () => {
      const streamId = 'steer-park';
      await manager.createJob(streamId, 'user-1');
      const leftovers: TPendingSteer[] = [
        { steerId: 'p1', text: 'unreceived words', createdAt: Date.now() },
      ];
      await manager.steering.park(streamId, leftovers, owner);

      expect(await manager.steering.claim(streamId, owner)).toEqual(leftovers);
      // A lost status response must not erase the only recovery copy.
      expect(await manager.steering.claim(streamId, owner)).toEqual(leftovers);
    });

    test('a stale generation cannot park leftovers onto a replacement', async () => {
      const streamId = 'steer-park-stale';
      const oldJob = await manager.createJob(streamId, 'user-1');
      await new Promise((resolve) => setTimeout(resolve, 2));
      const replacement = await manager.createJob(streamId, 'user-1');
      const leftovers: TPendingSteer[] = [
        { steerId: 'old', text: 'belongs to predecessor', createdAt: Date.now() },
      ];

      await manager.steering.park(streamId, leftovers, owner, oldJob.createdAt);
      expect(await manager.steering.claim(streamId, owner)).toEqual([]);

      await manager.steering.park(streamId, leftovers, owner, replacement.createdAt);
      expect(await manager.steering.claim(streamId, owner)).toEqual(leftovers);
    });

    test('parked leftovers survive completeJob within the terminal TTL', async () => {
      const streamId = 'steer-park-terminal';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.park(
        streamId,
        [{ steerId: 'p2', text: 'post-terminal recovery', createdAt: Date.now() }],
        owner,
      );
      await manager.completeJob(streamId);

      expect((await manager.steering.claim(streamId, owner)).map((s) => s.steerId)).toEqual(['p2']);
    });

    test('parked leftovers survive the DEFAULT completeJob cleanup (job record deleted)', async () => {
      // Production default: cleanupOnComplete deletes the job record the
      // moment the run succeeds — recovery must not depend on it existing.
      const defaultManager = new GenerationJobManagerClass();
      defaultManager.configure({
        jobStore: new InMemoryJobStore({ ttlAfterComplete: 0 }),
        eventTransport: new InMemoryEventTransport(),
        isRedis: false,
        cleanupOnComplete: true,
      });
      defaultManager.initialize();
      try {
        const streamId = 'steer-park-deleted-job';
        await defaultManager.createJob(streamId, 'user-1');
        await defaultManager.steering.park(
          streamId,
          [{ steerId: 'p4', text: 'survives job deletion', createdAt: Date.now() }],
          owner,
        );
        await defaultManager.completeJob(streamId);

        expect(await defaultManager.getJob(streamId)).toBeFalsy();
        expect(
          (await defaultManager.steering.claim(streamId, owner)).map((s) => s.steerId),
        ).toEqual(['p4']);
      } finally {
        await defaultManager.destroy();
      }
    });

    test('a non-owner claim returns nothing and preserves the payload for the owner', async () => {
      const streamId = 'steer-park-foreign';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.park(
        streamId,
        [{ steerId: 'p5', text: 'not yours', createdAt: Date.now() }],
        owner,
      );

      expect(await manager.steering.claim(streamId, { userId: 'intruder' })).toEqual([]);
      expect((await manager.steering.claim(streamId, owner)).map((s) => s.steerId)).toEqual(['p5']);
    });

    test('a non-owner claim never deletes the payload, even transiently (no re-park)', async () => {
      const streamId = 'steer-park-atomic';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.park(
        streamId,
        [{ steerId: 'p6', text: 'owner only', createdAt: Date.now() }],
        owner,
      );

      // The owner gate runs INSIDE the store's atomic claim: a rejected probe
      // must not go through the old delete-then-re-park path, which briefly
      // left nothing for a concurrent owner claim.
      const parkSpy = jest.spyOn(manager.getJobStore(), 'parkSteers');
      expect(await manager.steering.claim(streamId, { userId: 'intruder' })).toEqual([]);
      expect(parkSpy).not.toHaveBeenCalled();
      expect((await manager.steering.claim(streamId, owner)).map((s) => s.steerId)).toEqual(['p6']);
      parkSpy.mockRestore();
    });

    test('periodic store cleanup sweeps expired parked steers', async () => {
      const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
      const base = Date.now();
      const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
      try {
        await store.parkSteers(
          'steer-park-sweep',
          JSON.stringify({ userId: 'user-1', steers: [{ steerId: 'p7', text: 'stale' }] }),
        );
        nowSpy.mockReturnValue(base + PARKED_STEERS_TTL_MS + 1);
        await store.cleanup();
        // Back inside the window: had the sweep NOT removed the entry, this
        // claim would return it (expiry is otherwise only checked at read).
        nowSpy.mockReturnValue(base);
        expect(await store.claimParkedSteers('steer-park-sweep', 'user-1')).toBe(undefined);
      } finally {
        nowSpy.mockRestore();
        await store.destroy();
      }
    });

    test('a replacement preserves leftovers until it starts their exact recovery', async () => {
      const streamId = 'steer-park-replaced';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.park(
        streamId,
        [{ steerId: 'p3', text: 'stale', createdAt: Date.now() }],
        owner,
      );
      await manager.createJob(streamId, 'user-1');

      expect((await manager.steering.claim(streamId, owner)).map((item) => item.steerId)).toEqual([
        'p3',
      ]);

      const failedRecovery = await manager.createJob(streamId, 'user-1', undefined, {
        recoveredSteerId: 'p3',
        recoveredSteerPayload: { text: 'stale', fileIds: [], quotes: [] },
      });
      expect(await manager.steering.claim(streamId, owner)).toEqual([]);

      // Startup failed before the user message became durable: the lease is
      // non-destructive, so terminal status exposes the source again.
      await manager.completeJob(streamId, 'provider init failed', failedRecovery.createdAt);
      expect((await manager.steering.claim(streamId, owner)).map((item) => item.steerId)).toEqual([
        'p3',
      ]);

      const persistedRecovery = await manager.createJob(streamId, 'user-1', undefined, {
        recoveredSteerId: 'p3',
        recoveredSteerPayload: { text: 'stale', fileIds: [], quotes: [] },
      });
      expect(
        await manager.steering.consumeRecovered(streamId, 'p3', owner, persistedRecovery.createdAt),
      ).toBe(true);
      expect(await manager.steering.claim(streamId, owner)).toEqual([]);
    });

    test.each([
      ['changed text', { text: 'forged words', fileIds: ['file-a', 'file-b'], quotes: [] }],
      ['changed files', { text: 'original words', fileIds: ['file-a', 'file-c'], quotes: [] }],
    ])(
      'refuses recovery with %s without leasing or consuming the source',
      async (_label, proof) => {
        const streamId = `steer-recovery-mismatch-${_label.replace(' ', '-')}`;
        const originalJob = await manager.createJob(streamId, 'user-1');
        const source = {
          steerId: `source-${_label.replace(' ', '-')}`,
          text: 'original words',
          createdAt: Date.now(),
          files: [{ file_id: 'file-b' }, { file_id: 'file-a' }],
        };
        await manager.steering.park(streamId, [source], owner);

        await expect(
          manager.createJob(streamId, 'user-1', undefined, {
            recoveredSteerId: source.steerId,
            recoveredSteerPayload: proof,
          }),
        ).rejects.toMatchObject({ code: 'RECOVERY_PAYLOAD_MISMATCH' });

        expect((await manager.getJob(streamId))?.createdAt).toBe(originalJob.createdAt);
        expect(await manager.steering.claim(streamId, owner)).toEqual([source]);
      },
    );

    test('approval expiry parks queued steers instead of deleting them', async () => {
      const streamId = 'steer-expire-park';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.enqueue(streamId, buildSteer('frozen across the pause'));

      const payload = buildToolApprovalPayload([
        { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call_exp' },
      ]);
      const action = buildPendingAction(payload, {
        streamId,
        conversationId: streamId,
        runId: 'run-exp',
        responseMessageId: 'msg-exp',
      });
      expect(await manager.approvals.pause(streamId, action)).toBe(true);

      expect(await manager.expireApproval(streamId, action.actionId)).toBe(true);
      expect((await manager.steering.claim(streamId, owner)).map((s) => s.text)).toEqual([
        'frozen across the pause',
      ]);
    });
  });

  describe('terminal cleanup', () => {
    test('completeJob clears any leftover steers', async () => {
      const streamId = 'steer-complete';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.enqueue(streamId, buildSteer('leftover'));

      await manager.completeJob(streamId);
      expect(await manager.steering.peek(streamId)).toEqual([]);
    });

    test('completeJob backstop parks 202-accepted steers instead of dropping them', async () => {
      // Direct error-path callers (init failures, unhandled generation errors)
      // reach completeJob WITHOUT the controllers' close-and-park — the
      // backstop itself must leave the words claimable via /chat/status.
      const streamId = 'steer-complete-error';
      await manager.createJob(streamId, 'user-1');
      const steer = buildSteer('survives the boom');
      await manager.steering.enqueue(streamId, steer);

      await manager.completeJob(streamId, 'boom');

      expect(await manager.steering.peek(streamId)).toEqual([]);
      expect(
        (await manager.steering.claim(streamId, { userId: 'user-1' })).map((s) => s.steerId),
      ).toEqual([steer.steerId]);
    });

    test('abortJob drains leftovers into pendingSteers on the result and final event', async () => {
      const streamId = 'steer-abort';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.enqueue(streamId, buildSteer('unsent one'));
      await manager.steering.enqueue(streamId, buildSteer('unsent two'));

      const result = await manager.abortJob(streamId);
      expect(result.success).toBe(true);
      const steers = result.pendingSteers as TPendingSteer[];
      expect(steers.map((s) => s.text)).toEqual(['unsent one', 'unsent two']);
      expect(steers.every((s) => !('userId' in s))).toBe(true);
      expect(
        (result.finalEvent as { pendingSteers?: TPendingSteer[] }).pendingSteers?.map(
          (s) => s.text,
        ),
      ).toEqual(['unsent one', 'unsent two']);
      expect(await manager.steering.peek(streamId)).toEqual([]);
    });

    test('abortJob transforms content with metadata from the winning resume-race snapshot', async () => {
      const streamId = 'abort-resume-metadata-race';
      const job = await manager.createJob(streamId, 'user-1');
      const action = buildPendingAction(
        buildToolApprovalPayload([
          { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call-1' },
        ]),
        { streamId, conversationId: streamId, runId: 'run-1', responseMessageId: 'msg-1' },
      );
      expect(await manager.approvals.pause(streamId, action)).toBe(true);
      jobStore.setContentParts(streamId, [{ type: 'text', text: 'partial' }], job.createdAt);

      const originalGetContentParts = jobStore.getContentParts.bind(jobStore);
      let signalSnapshotStarted: (() => void) | undefined;
      const snapshotStarted = new Promise<void>((resolve) => {
        signalSnapshotStarted = resolve;
      });
      let releaseSnapshot: (() => void) | undefined;
      const snapshotGate = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      jest.spyOn(jobStore, 'getContentParts').mockImplementationOnce(async (...args) => {
        signalSnapshotStarted?.();
        await snapshotGate;
        return originalGetContentParts(...args);
      });
      let transformedWith: unknown;

      try {
        const aborting = manager.abortJob(streamId, {
          expectedCreatedAt: job.createdAt,
          transformAbortContent: (content, claimedJob) => {
            transformedWith = claimedJob.resolvedAskUserQuestions;
            return content;
          },
        });
        await snapshotStarted;
        await expect(
          manager.approvals.resolve(
            streamId,
            action.actionId,
            {
              resolvedAskUserQuestions: [
                {
                  request: 'Which environment?',
                  output: 'staging',
                },
              ],
            },
            job.createdAt,
          ),
        ).resolves.toBe(true);
        releaseSnapshot?.();

        await expect(aborting).resolves.toMatchObject({ success: true });
        expect(transformedWith).toEqual([
          {
            request: 'Which environment?',
            output: 'staging',
          },
        ]);
      } finally {
        releaseSnapshot?.();
      }
    });

    test('abortJob transforms content before filtering shifts reconstructed indices', async () => {
      const streamId = 'abort-transform-before-filter';
      const job = await manager.createJob(streamId, 'user-1');
      jobStore.setContentParts(
        streamId,
        [
          { type: 'text', text: '' },
          {
            type: 'tool_call',
            tool_call: { id: 'ask-1', name: 'ask_user_question', args: '' },
          },
        ],
        job.createdAt,
      );

      const result = await manager.abortJob(streamId, {
        expectedCreatedAt: job.createdAt,
        transformAbortContent: (content) => {
          expect(content).toHaveLength(2);
          const askPart = content[1];
          if (askPart?.type !== 'tool_call' || !('tool_call' in askPart)) {
            throw new Error('Expected reconstructed ask tool call at index 1');
          }
          const next = [...content];
          next[1] = {
            ...askPart,
            tool_call: {
              ...askPart.tool_call,
              output: 'staging',
              progress: 1,
            },
          } as unknown as TMessageContentParts;
          return next;
        },
      });

      expect(result.success).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({
          tool_call: expect.objectContaining({ output: 'staging', progress: 1 }),
        }),
      ]);
    });

    test('abortJob publishes nothing when natural completion wins its terminal CAS', async () => {
      const streamId = 'steer-abort-loses-terminal-race';
      const eventTransport = new InMemoryEventTransport();
      const emitDone = jest.spyOn(eventTransport, 'emitDone');
      const racingManager = new GenerationJobManagerClass();
      racingManager.configure({
        jobStore,
        eventTransport,
        isRedis: false,
        cleanupOnComplete: false,
      });
      racingManager.initialize();
      const job = await racingManager.createJob(streamId, 'user-1');
      const originalGetContentParts = jobStore.getContentParts.bind(jobStore);
      let signalSnapshotStarted: (() => void) | undefined;
      const snapshotStarted = new Promise<void>((resolve) => {
        signalSnapshotStarted = resolve;
      });
      let releaseSnapshot: (() => void) | undefined;
      const snapshotGate = new Promise<void>((resolve) => {
        releaseSnapshot = resolve;
      });
      jest.spyOn(jobStore, 'getContentParts').mockImplementationOnce(async (...args) => {
        signalSnapshotStarted?.();
        await snapshotGate;
        return originalGetContentParts(...args);
      });

      try {
        const aborting = racingManager.abortJob(streamId);
        await snapshotStarted;
        await racingManager.completeJob(streamId, undefined, job.createdAt);
        releaseSnapshot?.();

        await expect(aborting).resolves.toMatchObject({
          success: false,
          finalEvent: null,
        });
        await expect(jobStore.getJob(streamId)).resolves.toMatchObject({
          createdAt: job.createdAt,
          status: 'complete',
        });
        expect(emitDone).not.toHaveBeenCalled();
      } finally {
        releaseSnapshot?.();
        await racingManager.destroy();
      }
    });

    test('abort final events preserve HITL paths and derive applied steer paths', async () => {
      const streamId = 'steer-abort-provenance';
      await manager.createJob(streamId, 'user-1');
      await jobStore.updateJob(streamId, {
        conversationId: streamId,
        createdEventEmitted: true,
        responseMessageId: 'response-1',
        userMessage: { messageId: 'user-1' },
        userSubmittedPaths: ['/content/0/tool_call/args'],
        userSubmittedMessageFieldPaths: [
          { path: '/content/0/tool_call/output', field: 'decision_response' },
        ],
      });
      manager.setContentParts(streamId, [
        {
          type: 'tool_call',
          tool_call: { id: 'call-1', output: 'Human response' },
        },
        { type: 'steer', steer: 'Change direction' },
      ] as unknown as Agents.MessageContentComplex[]);

      const result = await manager.abortJob(streamId);

      expect(
        (
          result.finalEvent as
            | {
                responseMessage?: {
                  userSubmittedPaths?: string[];
                  userSubmittedMessageFieldPaths?: Array<{ path: string; field: string }>;
                };
              }
            | undefined
        )?.responseMessage,
      ).toMatchObject({
        userSubmittedPaths: ['/content/0/tool_call/args', '/content/1'],
        userSubmittedMessageFieldPaths: [
          { path: '/content/0/tool_call/output', field: 'decision_response' },
        ],
      });
    });
  });

  describe('synthesizeAppliedSteerEvents (snapshot→subscribe gap)', () => {
    const meta = { conversationId: 'convo-gap', responseMessageId: 'msg-gap' };
    const queued = (steerId: string): SteerQueueItem => ({
      steerId,
      text: 'still queued',
      userId: 'user-1',
      createdAt: Date.now(),
    });

    test('re-surfaces the applied part for a steer that left the queue in the gap', () => {
      const appliedPart = { type: 'steer', steerId: 'g1', steer: 'applied in gap' };
      const fresh = [{ type: 'text' }, appliedPart, { type: 'text' }];

      const events = synthesizeAppliedSteerEvents([], [queued('g2')], fresh, meta);

      expect(events).toHaveLength(1);
      const event = events[0] as { event: string; data: Record<string, unknown> };
      expect(event.event).toBe(SteerEvents.ON_STEER_APPLIED);
      expect(event.data.steerId).toBe('g1');
      expect(event.data.index).toBe(1);
      expect(event.data.part).toBe(appliedPart);
      expect(event.data.conversationId).toBe('convo-gap');
      expect(event.data.responseMessageId).toBe('msg-gap');
    });

    test('synthesizes a steer accepted AND applied in the gap (no snapshot id at all)', () => {
      const appliedPart = { type: 'steer', steerId: 'g5', steer: 'gap only' };

      const events = synthesizeAppliedSteerEvents([], [], [appliedPart], meta);

      expect(events).toHaveLength(1);
      const event = events[0] as { event: string; data: Record<string, unknown> };
      expect(event.data.steerId).toBe('g5');
      expect(event.data.index).toBe(0);
    });

    test('emits nothing when no steer part landed in the gap (terminally drained instead)', () => {
      expect(synthesizeAppliedSteerEvents([], [], [{ type: 'text' }], meta)).toEqual([]);
    });

    test('skips a part already in the snapshot applied set (it rode the sync payload)', () => {
      const part = { type: 'steer', steerId: 'g6' };

      expect(synthesizeAppliedSteerEvents([part], [], [{ type: 'text' }, part], meta)).toEqual([]);
    });

    test('skips a steer still in the live queue', () => {
      const fresh = [{ type: 'steer', steerId: 'g4' }];

      expect(synthesizeAppliedSteerEvents([], [queued('g4')], fresh, meta)).toEqual([]);
    });
  });

  describe('subscribeWithResume steer-gap reconciliation', () => {
    function staleSnapshot(streamId: string, pendingSteers?: TPendingSteer[]): ResumeState {
      return {
        runSteps: [],
        aggregatedContent: [],
        conversationId: streamId,
        responseMessageId: 'msg-gap',
        ...(pendingSteers && { pendingSteers }),
      };
    }

    test('refreshes the snapshot when a steer was ADDED in the gap', async () => {
      const streamId = 'steer-gap-added';
      await manager.createJob(streamId, 'user-1');
      const kept = buildSteer('kept');
      const added = buildSteer('added in gap');
      await manager.steering.enqueue(streamId, kept);
      await manager.steering.enqueue(streamId, added);

      jest
        .spyOn(manager, 'getResumeState')
        .mockResolvedValue(staleSnapshot(streamId, [toPendingSteer(kept)]));

      const result = await manager.subscribeWithResume(streamId, jest.fn());
      expect(result.resumeState?.pendingSteers?.map((s) => s.steerId)).toEqual([
        kept.steerId,
        added.steerId,
      ]);
      expect(result.pendingEvents).toEqual([]);
    });

    test('reconciles an equal-length id swap (one drained + one added)', async () => {
      const streamId = 'steer-gap-swap';
      await manager.createJob(streamId, 'user-1');
      const drained = buildSteer('drained in gap');
      const added = buildSteer('added in gap');
      await manager.steering.enqueue(streamId, added);

      const appliedPart = {
        type: 'steer',
        steer: drained.text,
        steerId: drained.steerId,
      };
      manager.setContentParts(streamId, [appliedPart] as unknown as Agents.MessageContentComplex[]);

      jest
        .spyOn(manager, 'getResumeState')
        .mockResolvedValue(staleSnapshot(streamId, [toPendingSteer(drained)]));

      const result = await manager.subscribeWithResume(streamId, jest.fn());
      // Same length, different ids: the live projection must win…
      expect(result.resumeState?.pendingSteers?.map((s) => s.steerId)).toEqual([added.steerId]);
      // …and the drained steer's applied part is re-surfaced as a gap event.
      expect(result.pendingEvents).toHaveLength(1);
      const event = result.pendingEvents[0] as { event: string; data: Record<string, unknown> };
      expect(event.event).toBe(SteerEvents.ON_STEER_APPLIED);
      expect(event.data.steerId).toBe(drained.steerId);
      expect(event.data.index).toBe(0);
    });

    test('refreshes an EMPTY snapshot when a steer was accepted in the gap', async () => {
      const streamId = 'steer-gap-empty-accept';
      await manager.createJob(streamId, 'user-1');
      const accepted = buildSteer('accepted in gap');
      await manager.steering.enqueue(streamId, accepted);

      jest.spyOn(manager, 'getResumeState').mockResolvedValue(staleSnapshot(streamId));

      const result = await manager.subscribeWithResume(streamId, jest.fn());
      expect(result.resumeState?.pendingSteers?.map((s) => s.steerId)).toEqual([accepted.steerId]);
      expect(result.pendingEvents).toEqual([]);
    });

    test('synthesizes the applied part for a gap steer the snapshot never saw', async () => {
      const streamId = 'steer-gap-empty-applied';
      await manager.createJob(streamId, 'user-1');
      // Gap activity on an empty snapshot: the take-all drain applied one
      // steer, then another was accepted. The queue delta triggers the
      // content re-read that surfaces the never-snapshotted applied part.
      const applied = buildSteer('accepted and applied in gap');
      const queuedAfter = buildSteer('accepted after the drain');
      await manager.steering.enqueue(streamId, queuedAfter);
      manager.setContentParts(streamId, [
        { type: 'steer', steer: applied.text, steerId: applied.steerId },
      ] as unknown as Agents.MessageContentComplex[]);

      jest.spyOn(manager, 'getResumeState').mockResolvedValue(staleSnapshot(streamId));

      const result = await manager.subscribeWithResume(streamId, jest.fn());
      expect(result.resumeState?.pendingSteers?.map((s) => s.steerId)).toEqual([
        queuedAfter.steerId,
      ]);
      expect(result.pendingEvents).toHaveLength(1);
      const event = result.pendingEvents[0] as { event: string; data: Record<string, unknown> };
      expect(event.event).toBe(SteerEvents.ON_STEER_APPLIED);
      expect(event.data.steerId).toBe(applied.steerId);
      expect(event.data.index).toBe(0);
    });

    test('an unchanged empty queue still checks the fresh content frontier', async () => {
      const streamId = 'steer-gap-quiet';
      const job = await manager.createJob(streamId, 'user-1');

      jest.spyOn(manager, 'getResumeState').mockResolvedValue(staleSnapshot(streamId));
      const readSpy = jest.spyOn(jobStore, 'getContentParts');

      const result = await manager.subscribeWithResume(streamId, jest.fn());
      expect(readSpy).toHaveBeenCalledWith(streamId, job.createdAt);
      expect(result.resumeState?.pendingSteers).toBeUndefined();
      expect(result.pendingEvents).toEqual([]);
    });

    test('a terminal job skips steer reconciliation (the final event owns delivery)', async () => {
      const streamId = 'steer-gap-terminal';
      await manager.createJob(streamId, 'user-1');
      await manager.completeJob(streamId, 'done');

      jest.spyOn(manager, 'getResumeState').mockResolvedValue(staleSnapshot(streamId));
      const peekSpy = jest.spyOn(jobStore, 'peekSteers');

      const result = await manager.subscribeWithResume(streamId, jest.fn());
      expect(peekSpy).not.toHaveBeenCalled();
      expect(result.resumeState?.pendingSteers).toBeUndefined();
      expect(result.pendingEvents).toEqual([]);
    });

    test('cancels when a replacement becomes durable after attachment', async () => {
      const streamId = 'steer-gap-replaced';
      const predecessor = await manager.createJob(streamId, 'user-1');
      const predecessorSteer = buildSteer('predecessor queue');
      await manager.steering.enqueue(streamId, predecessorSteer);
      jest
        .spyOn(manager, 'getResumeState')
        .mockResolvedValue(staleSnapshot(streamId, [toPendingSteer(predecessorSteer)]));

      const getJob = jobStore.getJob.bind(jobStore);
      const peekSpy = jest.spyOn(jobStore, 'peekSteers');
      const contentSpy = jest.spyOn(jobStore, 'getContentParts');
      let jobReadCount = 0;
      let replacementCreatedAt: number | undefined;
      jest.spyOn(jobStore, 'getJob').mockImplementation(async (requestedStreamId) => {
        jobReadCount++;
        if (jobReadCount === 3) {
          const replacement = await jobStore.createJob(requestedStreamId, 'user-1');
          replacementCreatedAt = replacement.createdAt;
          await jobStore.enqueueSteer(requestedStreamId, buildSteer('replacement queue'));
          return replacement;
        }
        return getJob(requestedStreamId);
      });

      const result = await manager.subscribeWithResume(streamId, jest.fn());

      expect(result.subscription).toBeNull();
      expect(result.pendingEvents).toEqual([]);
      expect(result.resumeState?.pendingSteers).toEqual([toPendingSteer(predecessorSteer)]);
      expect(peekSpy).not.toHaveBeenCalled();
      expect(contentSpy).not.toHaveBeenCalled();
      expect(replacementCreatedAt).toBeGreaterThan(predecessor.createdAt);
    });
  });

  describe('resume state', () => {
    test('getResumeState carries still-queued steers as a client-safe projection', async () => {
      const streamId = 'steer-resume';
      await manager.createJob(streamId, 'user-1');
      await manager.steering.enqueue(streamId, buildSteer('pending on reconnect'));

      const state = await manager.getResumeState(streamId);
      expect(state?.pendingSteers?.map((s) => s.text)).toEqual(['pending on reconnect']);
      expect(state?.pendingSteers?.every((s) => !('userId' in s))).toBe(true);
    });

    test('preserves claimed-prefix FIFO when equal timestamps sort UUIDs the other way', async () => {
      const streamId = 'steer-resume-equal-time-fifo';
      const createdAt = Date.now();
      const job = await manager.createJob(streamId, 'user-1');
      const claimedFirst: SteerQueueItem = {
        steerId: 'z-accepted-first',
        text: 'accepted first',
        userId: 'user-1',
        createdAt,
      };
      const queuedLater: SteerQueueItem = {
        steerId: 'a-accepted-later',
        text: 'accepted later',
        userId: 'user-1',
        createdAt,
      };

      await manager.steering.enqueue(streamId, claimedFirst, job.createdAt);
      await manager.steering.drain(streamId, job.createdAt);
      await manager.steering.enqueue(streamId, queuedLater, job.createdAt);

      const state = await manager.getResumeState(streamId);
      expect(state?.pendingSteers?.map((steer) => steer.steerId)).toEqual([
        'z-accepted-first',
        'a-accepted-later',
      ]);
    });

    test('getResumeState omits pendingSteers when the queue is empty', async () => {
      const streamId = 'steer-resume-empty';
      await manager.createJob(streamId, 'user-1');

      const state = await manager.getResumeState(streamId);
      expect(state?.pendingSteers).toBeUndefined();
    });
  });
});

describe('emitChunk durability (Redis-mode chunk log)', () => {
  const steerEvent: ServerSentEvent = {
    event: SteerEvents.ON_STEER_APPLIED,
    data: { steerId: 'durable-1', index: 0, part: { type: 'steer', steer: 'now' } },
  };

  function buildRedisModeManager(store: InMemoryJobStore, transport: InMemoryEventTransport) {
    const redisModeManager = new GenerationJobManagerClass();
    redisModeManager.configure({
      jobStore: store,
      eventTransport: transport,
      isRedis: true,
      cleanupOnComplete: false,
    });
    redisModeManager.initialize();
    return redisModeManager;
  }

  async function flushMicrotasks(times = 20): Promise<void> {
    for (let i = 0; i < times; i++) {
      await Promise.resolve();
    }
  }

  test('durable: true resolves only after the chunk append committed, before the publish', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    const transport = new InMemoryEventTransport();
    const redisModeManager = buildRedisModeManager(store, transport);
    try {
      const streamId = 'steer-durable';
      const job = await redisModeManager.createJob(streamId, 'user-1');

      let resolveAppend!: (value: boolean) => void;
      const appendGate = new Promise<boolean>((resolve) => {
        resolveAppend = resolve;
      });
      jest.spyOn(store, 'appendChunk').mockReturnValue(appendGate);
      const publishSpy = jest.spyOn(transport, 'emitChunk');

      let settled = false;
      const emit = redisModeManager.emitChunk(streamId, steerEvent, { durable: true }).then(() => {
        settled = true;
      });

      await flushMicrotasks();
      expect(settled).toBe(false);
      expect(publishSpy).not.toHaveBeenCalled();

      resolveAppend(true);
      await emit;
      expect(settled).toBe(true);
      expect(publishSpy).toHaveBeenCalledWith(streamId, steerEvent, job.createdAt);
    } finally {
      await redisModeManager.destroy();
    }
  });

  test('default emitChunk stays fire-and-forget (publishes without awaiting the append)', async () => {
    const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    const transport = new InMemoryEventTransport();
    const redisModeManager = buildRedisModeManager(store, transport);
    let subscription: Awaited<ReturnType<typeof redisModeManager.subscribe>> | undefined;
    try {
      const streamId = 'steer-fire-and-forget';
      const job = await redisModeManager.createJob(streamId, 'user-1');
      subscription = await redisModeManager.subscribe(streamId, () => undefined);

      // After subscriber admission, the per-delta hot path must not gate on durability.
      // Pre-admission events intentionally await the append so recovery cannot miss them.
      jest.spyOn(store, 'appendChunk').mockReturnValue(new Promise<boolean>(() => undefined));
      const publishSpy = jest.spyOn(transport, 'emitChunk');

      await redisModeManager.emitChunk(streamId, steerEvent);
      expect(publishSpy).toHaveBeenCalledWith(streamId, steerEvent, job.createdAt);
    } finally {
      subscription?.unsubscribe();
      await redisModeManager.destroy();
    }
  });

  test('a durable predecessor emission stops when the runtime is replaced during append', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(100);
    const store = new InMemoryJobStore({ ttlAfterComplete: 60000 });
    const transport = new InMemoryEventTransport();
    const redisModeManager = buildRedisModeManager(store, transport);
    let resolveAppend: ((value: boolean) => void) | undefined;

    try {
      const streamId = 'steer-durable-replaced';
      const predecessor = await redisModeManager.createJob(streamId, 'user-1');
      const appendStarted = new Promise<void>((resolve) => {
        jest.spyOn(store, 'appendChunk').mockImplementationOnce(
          () =>
            new Promise<boolean>((resolveAppendPromise) => {
              resolveAppend = resolveAppendPromise;
              resolve();
            }),
        );
      });
      const publishSpy = jest.spyOn(transport, 'emitChunk');
      const staleEmission = redisModeManager.emitChunk(streamId, steerEvent, { durable: true });
      await appendStarted;

      now.mockReturnValue(200);
      const replacement = await redisModeManager.createJob(streamId, 'user-1');
      resolveAppend?.(true);
      await staleEmission;

      expect(predecessor.abortController.signal.aborted).toBe(true);
      expect(replacement.abortController.signal.aborted).toBe(false);
      expect(publishSpy).not.toHaveBeenCalled();
    } finally {
      resolveAppend?.(true);
      now.mockRestore();
      await redisModeManager.destroy();
    }
  });
});

describe('preempt request lifecycle (in-memory)', () => {
  let manager: GenerationJobManagerClass;

  function createControlledPreemptManager(): {
    controlled: GenerationJobManagerClass;
    deliver: (message: PreemptMessage) => void;
  } {
    let listener: ((message: PreemptMessage) => void) | undefined;
    const eventTransport: IEventTransport = Object.assign(new InMemoryEventTransport(), {
      onPreempt: (_streamId: string, callback: (message: PreemptMessage) => void) => {
        listener = callback;
        return () => {
          if (listener === callback) {
            listener = undefined;
          }
        };
      },
    });
    const controlled = new GenerationJobManagerClass();
    controlled.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    controlled.initialize();
    return {
      controlled,
      deliver: (message) => {
        if (listener == null) {
          throw new Error('Preempt listener is not registered');
        }
        listener(message);
      },
    };
  }

  beforeEach(() => {
    manager = new GenerationJobManagerClass();
    manager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    manager.initialize();
  });

  afterEach(async () => {
    await manager.destroy();
  });

  test('requestPreempt without a runtime is a no-op and the poll stays false', () => {
    manager.requestPreempt('preempt-no-runtime', 'steer-1', Date.now());
    expect(manager.isPreemptRequested('preempt-no-runtime')).toBe(false);
  });

  test('arms against the live generation and stays armed until cleared', async () => {
    const streamId = 'preempt-arm';
    const job = await manager.createJob(streamId, 'user-1');

    manager.requestPreempt(streamId, 'steer-1', job.createdAt);
    expect(manager.isPreemptRequested(streamId)).toBe(true);
    expect(manager.isPreemptRequested(streamId)).toBe(true);

    manager.noteSteersRemoved(streamId, ['steer-1'], job.createdAt);
    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  test('refuses to arm when jobCreatedAt does not match the live generation', async () => {
    const streamId = 'preempt-stale-arm';
    const job = await manager.createJob(streamId, 'user-1');

    manager.requestPreempt(streamId, 'steer-1', job.createdAt - 1);
    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  test('clears only the removed steerIds', async () => {
    const streamId = 'preempt-partial-clear';
    const job = await manager.createJob(streamId, 'user-1');

    manager.requestPreempt(streamId, 'steer-1', job.createdAt);
    manager.requestPreempt(streamId, 'steer-2', job.createdAt);
    manager.noteSteersRemoved(streamId, ['steer-1'], job.createdAt);
    expect(manager.isPreemptRequested(streamId)).toBe(true);
    manager.noteSteersRemoved(streamId, ['steer-2'], job.createdAt);
    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  test('caps armed requests at STEER_QUEUE_MAX_DEPTH', async () => {
    const streamId = 'preempt-cap';
    const job = await manager.createJob(streamId, 'user-1');

    for (let i = 0; i < STEER_QUEUE_MAX_DEPTH + 5; i++) {
      manager.requestPreempt(streamId, `steer-${i}`, job.createdAt);
    }
    for (let i = 0; i < STEER_QUEUE_MAX_DEPTH; i++) {
      manager.noteSteersRemoved(streamId, [`steer-${i}`], job.createdAt);
    }
    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  test('arming never changes job status', async () => {
    const streamId = 'preempt-status';
    const job = await manager.createJob(streamId, 'user-1');

    manager.requestPreempt(streamId, 'steer-1', job.createdAt);
    expect((await manager.getJob(streamId))?.status).toBe('running');
  });

  test('a failing preempt subscription degrades the job instead of crashing the process', async () => {
    const transport: IEventTransport = new InMemoryEventTransport();
    transport.onPreempt = jest.fn().mockRejectedValue(new Error('SUBSCRIBE failed'));

    /**
     * The registration is deliberately detached, so a rejection propagating out
     * of it would be unhandled — fatal under Node's default settings.
     */
    const unhandled: unknown[] = [];
    const collect = (reason: unknown): number => unhandled.push(reason);
    process.on('unhandledRejection', collect);
    const logged = jest.spyOn(logger, 'error').mockImplementation(() => logger);

    const degraded = new GenerationJobManagerClass();
    degraded.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: transport,
      isRedis: false,
      cleanupOnComplete: false,
    });
    degraded.initialize();

    try {
      const streamId = 'preempt-subscribe-fails';
      const job = await degraded.createJob(streamId, 'user-1');
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).toEqual([]);
      expect(job.status).toBe('running');
      expect(logged).toHaveBeenCalledWith(
        expect.stringContaining('Failed to subscribe to preempts'),
        expect.any(Error),
      );

      /** Same-replica arming is runtime state, so it survives the lost channel. */
      degraded.requestPreempt(streamId, 'steer-1', job.createdAt);
      expect(degraded.isPreemptRequested(streamId)).toBe(true);
    } finally {
      process.off('unhandledRejection', collect);
      logged.mockRestore();
      await degraded.destroy();
    }
  });

  test('abortJob retires the armed set with the runtime', async () => {
    const streamId = 'preempt-abort';
    const job = await manager.createJob(streamId, 'user-1');
    await manager.steering.enqueue(streamId, {
      steerId: 'steer-1',
      text: 'interrupt me',
      userId: 'user-1',
      createdAt: Date.now(),
      preempt: true,
    });
    manager.requestPreempt(streamId, 'steer-1', job.createdAt);

    await manager.abortJob(streamId);
    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  test('completeJob retires the armed set', async () => {
    const streamId = 'preempt-complete';
    const job = await manager.createJob(streamId, 'user-1');
    manager.requestPreempt(streamId, 'steer-1', job.createdAt);

    await manager.completeJob(streamId, undefined, job.createdAt);
    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  test('toPendingSteer keeps preempt and client correlation for parked/replayed chips', () => {
    const item: SteerQueueItem = {
      steerId: 'steer-1',
      clientSteerId: 'local-steer-1',
      text: 'interrupt me',
      userId: 'user-1',
      createdAt: Date.now(),
      preempt: true,
    };
    expect(toPendingSteer(item).preempt).toBe(true);
    expect(toPendingSteer(item).clientSteerId).toBe('local-steer-1');
    expect(toPendingSteer({ ...item, preempt: undefined }).preempt).toBeUndefined();
  });

  test('a late arm cannot resurrect an already-cleared steer', async () => {
    const streamId = 'preempt-late-arm';
    const job = await manager.createJob(streamId, 'user-1');

    /** The generating replica drained + cleared before this replica's arm. */
    manager.noteSteersRemoved(streamId, ['steer-1'], job.createdAt);
    manager.requestPreempt(streamId, 'steer-1', job.createdAt);

    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  test('the tombstone is per-steer, not a blanket disarm', async () => {
    const streamId = 'preempt-tombstone-scope';
    const job = await manager.createJob(streamId, 'user-1');

    manager.noteSteersRemoved(streamId, ['steer-1'], job.createdAt);
    manager.requestPreempt(streamId, 'steer-1', job.createdAt);
    manager.requestPreempt(streamId, 'steer-2', job.createdAt);

    expect(manager.isPreemptRequested(streamId)).toBe(true);
    manager.noteSteersRemoved(streamId, ['steer-2'], job.createdAt);
    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  test('clearPreemptRequests disarms the ids it is given', async () => {
    const streamId = 'preempt-clear-all';
    const job = await manager.createJob(streamId, 'user-1');
    manager.requestPreempt(streamId, 'steer-1', job.createdAt);
    manager.requestPreempt(streamId, 'steer-2', job.createdAt);

    const armed = manager.getArmedPreemptIds(streamId, job.createdAt);
    expect(armed.sort()).toEqual(['steer-1', 'steer-2']);
    manager.clearPreemptRequests(streamId, armed, job.createdAt);
    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  /**
   * A steer can enqueue and arm while a drain is in flight. The empty-boundary
   * disarm must not wipe it — its queue item is live and uninjected.
   */
  test('clearPreemptRequests spares an arm that landed after the snapshot', async () => {
    const streamId = 'preempt-clear-scoped';
    const job = await manager.createJob(streamId, 'user-1');
    manager.requestPreempt(streamId, 'steer-old', job.createdAt);

    const snapshot = manager.getArmedPreemptIds(streamId, job.createdAt);
    manager.requestPreempt(streamId, 'steer-new', job.createdAt);
    manager.clearPreemptRequests(streamId, snapshot, job.createdAt);

    expect(manager.isPreemptRequested(streamId)).toBe(true);
  });

  test('clearPreemptRequests refuses a stale generation', async () => {
    const streamId = 'preempt-clear-stale';
    const job = await manager.createJob(streamId, 'user-1');
    manager.requestPreempt(streamId, 'steer-1', job.createdAt);

    manager.clearPreemptRequests(streamId, ['steer-1'], job.createdAt - 1);
    expect(manager.isPreemptRequested(streamId)).toBe(true);
  });

  /**
   * Every drained or cancelled steer is tombstoned, not just preempting ones,
   * so a refusing cap would stop recording after a long generation and let the
   * late-arm race resurface. Eviction keeps the newest removals authoritative.
   */
  test('tombstones evict oldest-first instead of refusing new removals', async () => {
    const streamId = 'preempt-tombstone-evict';
    const job = await manager.createJob(streamId, 'user-1');

    for (let i = 0; i < STEER_QUEUE_MAX_DEPTH * 2 + 5; i++) {
      manager.noteSteersRemoved(streamId, [`bulk-${i}`], job.createdAt);
    }
    /** The most recent removal must still be remembered. */
    const recent = `bulk-${STEER_QUEUE_MAX_DEPTH * 2 + 4}`;
    manager.requestPreempt(streamId, recent, job.createdAt);
    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  /**
   * An arm lives only in the owning replica's runtime; the steer's `preempt`
   * flag is durable. A resume landing on another replica must rebuild the
   * armed set from the queue or the acknowledged interrupt silently waits for
   * an ordinary tool boundary.
   */
  test('rearmQueuedPreempts rebuilds the armed set from the durable queue', async () => {
    const streamId = 'preempt-rearm';
    const job = await manager.createJob(streamId, 'user-1', undefined, {
      initialMetadata: { preemptCapable: true },
    });
    await manager.steering.enqueue(streamId, {
      steerId: 'steer-preempt',
      text: 'interrupt me',
      userId: 'user-1',
      createdAt: Date.now(),
      preempt: true,
    });
    await manager.steering.enqueue(streamId, {
      steerId: 'steer-plain',
      text: 'ordinary steer',
      userId: 'user-1',
      createdAt: Date.now(),
    });

    /** Fresh owner: nothing armed locally yet. */
    expect(manager.isPreemptRequested(streamId)).toBe(false);

    const rearmed = await manager.rearmQueuedPreempts(streamId, job.createdAt);

    expect(rearmed).toBe(1);
    expect(manager.isPreemptRequested(streamId)).toBe(true);
    expect(manager.getArmedPreemptIds(streamId, job.createdAt)).toEqual(['steer-preempt']);
  });

  /**
   * A replica that only READ this job still installed a facade runtime and
   * subscribed, so it can hold an arm whose clear it later missed. Promotion
   * to owner on HITL resume would make that orphan live: the first resumed
   * stream seals on a steer that is no longer queued, drains nothing, and
   * truncates the resumed answer. The durable queue is the authority at a
   * handover, so an arm it does not back must be dropped, not merged.
   */
  test('rearmQueuedPreempts drops an armed id the durable queue no longer backs', async () => {
    const streamId = 'preempt-rearm-orphan';
    const job = await manager.createJob(streamId, 'user-1', undefined, {
      initialMetadata: { preemptCapable: true },
    });

    /** Arm survived from before ownership moved; its steer is long drained. */
    manager.requestPreempt(streamId, 'steer-orphan', job.createdAt);
    await manager.steering.enqueue(streamId, {
      steerId: 'steer-live',
      text: 'interrupt me',
      userId: 'user-1',
      createdAt: Date.now(),
      preempt: true,
    });
    expect(manager.getArmedPreemptIds(streamId, job.createdAt)).toContain('steer-orphan');

    const rearmed = await manager.rearmQueuedPreempts(streamId, job.createdAt);

    expect(rearmed).toBe(1);
    expect(manager.getArmedPreemptIds(streamId, job.createdAt)).toEqual(['steer-live']);
  });

  /**
   * `approvals.resolve` reopens steering before reconciliation runs, so a
   * steer enqueued on another replica can arm this one WHILE the queue read
   * is in flight. Reading the queue first would see that arm as unbacked and
   * tombstone a live interrupt the route already acknowledged — and the
   * tombstone would block the re-arm, so it could never recover.
   */
  test('an arm that lands while the queue is being read is not tombstoned', async () => {
    const streamId = 'preempt-rearm-race';
    const job = await manager.createJob(streamId, 'user-1', undefined, {
      initialMetadata: { preemptCapable: true },
    });

    const peek = manager.steering.peek.bind(manager.steering);
    const spy = jest
      .spyOn(manager.steering, 'peek')
      .mockImplementation(async (id: string, expectedCreatedAt?: number) => {
        const snapshot = await peek(id, expectedCreatedAt);
        /** Another replica commits a steer and publishes its arm, both after
         *  this snapshot was taken. */
        await manager.steering.enqueue(streamId, {
          steerId: 'steer-inflight',
          text: 'interrupt me',
          userId: 'user-1',
          createdAt: Date.now(),
          preempt: true,
        });
        manager.requestPreempt(streamId, 'steer-inflight', job.createdAt);
        return snapshot;
      });

    try {
      await manager.rearmQueuedPreempts(streamId, job.createdAt);
    } finally {
      spy.mockRestore();
    }

    expect(manager.getArmedPreemptIds(streamId, job.createdAt)).toContain('steer-inflight');
    expect(manager.isPreemptRequested(streamId)).toBe(true);
  });

  test('an orphan dropped at handover is tombstoned against a late arm', async () => {
    const streamId = 'preempt-rearm-orphan-tombstone';
    const job = await manager.createJob(streamId, 'user-1', undefined, {
      initialMetadata: { preemptCapable: true },
    });

    manager.requestPreempt(streamId, 'steer-orphan', job.createdAt);
    await manager.rearmQueuedPreempts(streamId, job.createdAt);
    expect(manager.isPreemptRequested(streamId)).toBe(false);

    /** A publish that was in flight while ownership moved must not revive it. */
    manager.requestPreempt(streamId, 'steer-orphan', job.createdAt);
    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  test('a delayed arm stays disarmed after its steer drained and reconciliation saw empty', async () => {
    const { controlled, deliver } = createControlledPreemptManager();
    const streamId = 'preempt-delayed-after-reconcile';
    try {
      const job = await controlled.createJob(streamId, 'user-1', undefined, {
        initialMetadata: { preemptCapable: true },
      });
      const enqueued = await controlled.steering.enqueueVersioned(
        streamId,
        {
          steerId: 'steer-delayed',
          text: 'interrupt me',
          userId: 'user-1',
          createdAt: Date.now(),
        },
        true,
        job.createdAt,
      );
      if (typeof enqueued === 'number') {
        throw new Error(`Unexpected enqueue rejection: ${enqueued}`);
      }

      /** Simulate a remote drain whose CLEAR was lost, then ownership
       * reconciliation completing before the buffered ARM is delivered. */
      await controlled.steering.drain(streamId, job.createdAt);
      expect(await controlled.rearmQueuedPreempts(streamId, job.createdAt)).toBe(0);

      deliver({
        op: 'arm',
        createdAt: job.createdAt,
        steerIds: [enqueued.item.steerId],
        revisions: { [enqueued.item.steerId]: enqueued.item.preemptRevision ?? 0 },
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(controlled.getArmedPreemptIds(streamId, job.createdAt)).toEqual([]);
      expect(controlled.isPreemptRequested(streamId)).toBe(false);
    } finally {
      await controlled.destroy();
    }
  });

  test('a drain between arm validation and local arming leaves a tombstone', async () => {
    const { controlled, deliver } = createControlledPreemptManager();
    const streamId = 'preempt-drain-during-validation';
    const peek = controlled.steering.peek.bind(controlled.steering);
    let drainedDuringValidation = false;
    const peekSpy = jest
      .spyOn(controlled.steering, 'peek')
      .mockImplementation(async (id: string, expectedCreatedAt?: number) => {
        const snapshot = await peek(id, expectedCreatedAt);
        const drained = await controlled.steering.drain(id, expectedCreatedAt);
        drainedDuringValidation = drained.length > 0;
        await controlled.noteSteersRemoved(
          id,
          drained.map((item) => item.steerId),
          expectedCreatedAt,
        );
        return snapshot;
      });

    try {
      const job = await controlled.createJob(streamId, 'user-1', undefined, {
        initialMetadata: { preemptCapable: true },
      });
      const enqueued = await controlled.steering.enqueueVersioned(
        streamId,
        {
          steerId: 'steer-validation-race',
          text: 'interrupt me',
          userId: 'user-1',
          createdAt: Date.now(),
        },
        true,
        job.createdAt,
      );
      if (typeof enqueued === 'number') {
        throw new Error(`Unexpected enqueue rejection: ${enqueued}`);
      }

      deliver({
        op: 'arm',
        createdAt: job.createdAt,
        steerIds: [enqueued.item.steerId],
        revisions: { [enqueued.item.steerId]: enqueued.item.preemptRevision ?? 0 },
      });
      await new Promise((resolve) => setImmediate(resolve));

      expect(drainedDuringValidation).toBe(true);
      expect(controlled.getArmedPreemptIds(streamId, job.createdAt)).toEqual([]);
      expect(controlled.isPreemptRequested(streamId)).toBe(false);
    } finally {
      peekSpy.mockRestore();
      await controlled.destroy();
    }
  });

  test('rearmQueuedPreempts refuses a stale generation and arms nothing', async () => {
    const streamId = 'preempt-rearm-stale';
    const job = await manager.createJob(streamId, 'user-1');
    await manager.steering.enqueue(streamId, {
      steerId: 'steer-preempt',
      text: 'interrupt me',
      userId: 'user-1',
      createdAt: Date.now(),
      preempt: true,
    });

    expect(await manager.rearmQueuedPreempts(streamId, job.createdAt - 1)).toBe(0);
    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  /**
   * A non-owning replica can only publish. The subscriber count is NOT proof
   * of owner receipt — this replica's own facade subscription is counted too
   * — so a successful publish is reported as armed and only a rejected one
   * is reported as unarmed. See the acknowledgement-semantics note on #14518.
   */
  test('a successful cross-replica publish reports armed', async () => {
    const streamId = 'preempt-published';
    const published = new GenerationJobManagerClass();
    published.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: Object.assign(new InMemoryEventTransport(), {
        emitPreempt: async () => 0,
      }),
      isRedis: false,
      cleanupOnComplete: false,
    });
    published.initialize();
    try {
      expect(await published.requestPreempt(streamId, 'steer-1', Date.now())).toBe(true);
    } finally {
      await published.destroy();
    }
  });

  /**
   * A facade runtime exists on any replica that merely READ the job, so
   * ownership must come from `ownedJobs` — arming a facade satisfies nothing
   * while reporting success.
   */
  test('a facade runtime on a non-owning replica does not count as armed locally', async () => {
    const streamId = 'preempt-facade';
    const facade = new GenerationJobManagerClass();
    facade.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    facade.initialize();
    try {
      /** No transport publish and no ownership: nothing can arm. */
      expect(await facade.requestPreempt(streamId, 'steer-1', Date.now())).toBe(false);
      expect(facade.isPreemptRequested(streamId)).toBe(false);
    } finally {
      await facade.destroy();
    }
  });

  /**
   * The steer drained at an ordinary boundary while the request was still in
   * flight, so its id is tombstoned and no arm is accepted — the 202 must not
   * claim an interrupt that cannot happen.
   */
  test('reports not-armed when the id was already tombstoned', async () => {
    const streamId = 'preempt-tombstoned-arm';
    const job = await manager.createJob(streamId, 'user-1');
    await manager.noteSteersRemoved(streamId, ['steer-late'], job.createdAt);

    expect(await manager.requestPreempt(streamId, 'steer-late', job.createdAt)).toBe(false);
    expect(manager.isPreemptRequested(streamId)).toBe(false);
  });

  test('reports armed when this replica owns the generation', async () => {
    const streamId = 'preempt-owned-here';
    const job = await manager.createJob(streamId, 'user-1');
    expect(await manager.requestPreempt(streamId, 'steer-1', job.createdAt)).toBe(true);
    expect(manager.isPreemptRequested(streamId)).toBe(true);
  });

  test('a failed publish does not throw out of requestPreempt', async () => {
    const streamId = 'preempt-publish-throws';
    const failing = new GenerationJobManagerClass();
    failing.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: Object.assign(new InMemoryEventTransport(), {
        emitPreempt: async () => {
          throw new Error('redis down');
        },
      }),
      isRedis: false,
      cleanupOnComplete: false,
    });
    failing.initialize();
    try {
      expect(await failing.requestPreempt(streamId, 'steer-1', Date.now())).toBe(false);
    } finally {
      await failing.destroy();
    }
  });

  test('retries a synchronous preempt-clear publish failure without throwing', async () => {
    const streamId = 'preempt-clear-sync-throw';
    let attempts = 0;
    const retrying = new GenerationJobManagerClass();
    retrying.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: Object.assign(new InMemoryEventTransport(), {
        emitPreempt: () => {
          attempts++;
          if (attempts === 1) {
            throw new Error('publisher not ready');
          }
        },
      }),
      isRedis: false,
      cleanupOnComplete: false,
    });
    retrying.initialize();
    try {
      await expect(retrying.noteSteersRemoved(streamId, ['steer-1'], Date.now())).resolves.toBe(
        true,
      );
      expect(attempts).toBe(2);
    } finally {
      await retrying.destroy();
    }
  });
});
