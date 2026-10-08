import type { IMongoFile } from '@librechat/data-schemas';
import { InMemoryEventTransport } from '~/stream/implementations/InMemoryEventTransport';
import { buildPendingAction, buildToolApprovalPayload } from '~/agents/hitl/policy';
import { handleSteerRequest, handleSteerCancel, handleSteerArm } from '../request';
import { InMemoryJobStore } from '~/stream/implementations/InMemoryJobStore';
import { isSteeringSupported, isSteerPreemptSupported } from '../runtime';
import { STEER_QUEUE_MAX_DEPTH } from '~/stream/interfaces/IJobStore';
import { GenerationJobManager } from '~/stream/GenerationJobManager';

jest.mock('../runtime', () => ({
  ...jest.requireActual('../runtime'),
  isSteeringSupported: jest.fn(() => true),
  isSteerPreemptSupported: jest.fn(() => true),
}));

jest.spyOn(console, 'log').mockImplementation();

const mockIsSupported = isSteeringSupported as jest.Mock;
const mockIsPreemptSupported = isSteerPreemptSupported as jest.Mock;
const user = { id: 'user-1' };

async function removeStoredJobOwner(streamId: string): Promise<void> {
  const stored = await GenerationJobManager.getJobStore().getJob(streamId);
  expect(stored).not.toBeNull();
  delete (stored as { userId?: string }).userId;
}

describe('handleSteerRequest (real in-memory job manager)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSupported.mockReturnValue(true);
    mockIsPreemptSupported.mockReturnValue(true);
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  it('400s on a missing or placeholder conversationId', async () => {
    expect((await handleSteerRequest(user, { text: 'hello' })).status).toBe(400);
    const placeholder = await handleSteerRequest(user, { conversationId: 'new', text: 'hello' });
    expect(placeholder.status).toBe(400);
    expect(placeholder.body.code).toBe('INVALID_CONVERSATION');
  });

  it('400s on empty or whitespace-only text', async () => {
    const result = await handleSteerRequest(user, { conversationId: 'c1', text: '   ' });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('EMPTY_TEXT');
  });

  it('400s an invalid client correlation id', async () => {
    const result = await handleSteerRequest(user, {
      conversationId: 'c1',
      text: 'valid text',
      clientSteerId: 'not valid whitespace',
    });
    expect(result.status).toBe(400);
    expect(result.body.code).toBe('INVALID_CLIENT_STEER_ID');
  });

  it('requires a client correlation id when idempotent delivery is mandatory', async () => {
    const result = await handleSteerRequest(
      user,
      { conversationId: 'c1', text: 'valid text' },
      { requireIdempotentDelivery: true },
    );

    expect(result).toEqual({
      status: 400,
      body: { code: 'CLIENT_STEER_ID_REQUIRED' },
    });
  });

  it('400s an invalid generation identity', async () => {
    const result = await handleSteerRequest(user, {
      conversationId: 'c1',
      generationCreatedAt: '1000',
      text: 'valid text',
    });
    expect(result).toEqual({
      status: 400,
      body: { code: 'INVALID_GENERATION_IDENTITY' },
    });
  });

  it('409s a steer targeting a replaced generation without touching the live queue', async () => {
    const streamId = 'steer-stale-generation';
    const job = await GenerationJobManager.createJob(streamId, user.id);

    const result = await handleSteerRequest(user, {
      conversationId: streamId,
      generationCreatedAt: job.createdAt - 1,
      text: 'belongs to the previous turn',
    });

    expect(result).toEqual({ status: 409, body: { code: 'RUN_REPLACED' } });
    await expect(GenerationJobManager.steering.peek(streamId)).resolves.toEqual([]);
  });

  it('413s past the length cap', async () => {
    const result = await handleSteerRequest(user, {
      conversationId: 'c1',
      text: 'x'.repeat(16001),
    });
    expect(result.status).toBe(413);
    expect(result.body.code).toBe('STEER_TOO_LONG');
  });

  it('400s on malformed or oversized file lists', async () => {
    const malformed = await handleSteerRequest(user, {
      conversationId: 'c1',
      text: 'x',
      files: [{ nope: true }],
    });
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('INVALID_FILES');

    const oversized = await handleSteerRequest(user, {
      conversationId: 'c1',
      text: 'x',
      files: Array.from({ length: 11 }, (_, i) => ({ file_id: `f${i}` })),
    });
    expect(oversized.status).toBe(400);
    expect(oversized.body.code).toBe('TOO_MANY_FILES');
  });

  it('501s when the installed SDK cannot inject hook messages (running job)', async () => {
    mockIsSupported.mockReturnValue(false);
    const streamId = 'steer-req-unsupported';
    await GenerationJobManager.createJob(streamId, user.id);
    const result = await handleSteerRequest(user, { conversationId: streamId, text: 'hello' });
    expect(result.status).toBe(501);
    expect(result.body.code).toBe('STEER_UNSUPPORTED');
  });

  it('404s before the capability gate when the run already finished', async () => {
    // A steer racing completion on an unsupported SDK must send-now (404),
    // not strand text in a queue with no run-end signal left to drain it.
    mockIsSupported.mockReturnValue(false);
    const result = await handleSteerRequest(user, { conversationId: 'finished', text: 'x' });
    expect(result.status).toBe(404);
    expect(result.body.code).toBe('NO_ACTIVE_RUN');
  });

  it('404s when the job is missing or terminal', async () => {
    const missing = await handleSteerRequest(user, { conversationId: 'gone', text: 'x' });
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NO_ACTIVE_RUN');

    const streamId = 'steer-req-terminal';
    await GenerationJobManager.createJob(streamId, user.id);
    await GenerationJobManager.completeJob(streamId);
    const terminal = await handleSteerRequest(user, { conversationId: streamId, text: 'x' });
    expect(terminal.status).toBe(404);
  });

  it('403s for another user', async () => {
    const streamId = 'steer-req-owner';
    await GenerationJobManager.createJob(streamId, 'someone-else');
    const result = await handleSteerRequest(user, { conversationId: streamId, text: 'x' });
    expect(result.status).toBe(403);
    expect(result.body.code).toBe('UNAUTHORIZED');
  });

  it('fails closed when the stored job owner is missing', async () => {
    const streamId = 'steer-req-missing-owner';
    await GenerationJobManager.createJob(streamId, user.id);
    await removeStoredJobOwner(streamId);

    const result = await handleSteerRequest(user, { conversationId: streamId, text: 'x' });

    expect(result).toEqual({ status: 403, body: { code: 'UNAUTHORIZED' } });
    await expect(GenerationJobManager.steering.peek(streamId)).resolves.toEqual([]);
  });

  it('409s while the run is paused for human review', async () => {
    const streamId = 'steer-req-paused';
    await GenerationJobManager.createJob(streamId, user.id);
    const payload = buildToolApprovalPayload([
      { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call_abc' },
    ]);
    const action = buildPendingAction(payload, {
      streamId,
      conversationId: streamId,
      runId: 'run-1',
      responseMessageId: 'msg-1',
    });
    expect(await GenerationJobManager.approvals.pause(streamId, action)).toBe(true);

    const result = await handleSteerRequest(user, { conversationId: streamId, text: 'x' });
    expect(result.status).toBe(409);
    expect(result.body.code).toBe('RUN_PAUSED');
  });

  it('429s when the queue is full', async () => {
    const streamId = 'steer-req-full';
    await GenerationJobManager.createJob(streamId, user.id);
    for (let i = 0; i < STEER_QUEUE_MAX_DEPTH; i++) {
      const accepted = await handleSteerRequest(user, {
        conversationId: streamId,
        text: `steer ${i}`,
      });
      expect(accepted.status).toBe(202);
    }
    const overflow = await handleSteerRequest(user, { conversationId: streamId, text: 'over' });
    expect(overflow.status).toBe(429);
    expect(overflow.body.code).toBe('STEER_QUEUE_FULL');
  });

  it('429s a new receipt at the history cap while existing ids remain replayable', async () => {
    const streamId = 'steer-req-receipt-full';
    await GenerationJobManager.createJob(streamId, user.id);
    for (let index = 0; index < 100; index++) {
      const accepted = await handleSteerRequest(user, {
        conversationId: streamId,
        clientSteerId: `receipt-cap-${index}`,
        text: `steer ${index}`,
      });
      expect(accepted.status).toBe(202);
      await expect(
        GenerationJobManager.steering.cancel(streamId, accepted.body.steerId as string),
      ).resolves.toBe(true);
    }

    const overflow = await handleSteerRequest(user, {
      conversationId: streamId,
      clientSteerId: 'receipt-cap-overflow',
      text: 'must not queue',
    });
    expect(overflow).toEqual({ status: 429, body: { code: 'STEER_RECEIPT_LIMIT' } });
    await expect(GenerationJobManager.steering.peek(streamId)).resolves.toEqual([]);

    const replay = await handleSteerRequest(user, {
      conversationId: streamId,
      clientSteerId: 'receipt-cap-0',
      text: 'steer 0',
    });
    expect(replay.status).toBe(202);
    expect(replay.body).toMatchObject({ replayed: true, settled: true });
  });

  it('202s, sanitizes the text, and enqueues sanitized attachment refs', async () => {
    const streamId = 'steer-req-accept';
    await GenerationJobManager.createJob(streamId, user.id);

    const result = await handleSteerRequest(user, {
      conversationId: streamId,
      clientSteerId: 'local-correlation-123',
      text: '  focus on tests\0  ',
      files: [
        {
          file_id: 'f1',
          type: 'image/png',
          filepath: '/uploads/f1.png',
          filename: 'shot.png',
          height: 10,
          width: 20,
          bytes: 999,
          llmDeliveryPath: 'text',
          user: 'someone-else',
          embedded: true,
        },
      ],
    });

    expect(result.status).toBe(202);
    expect(result.body).toMatchObject({
      status: 'queued',
      position: 1,
      conversationId: streamId,
    });
    expect(typeof result.body.steerId).toBe('string');

    const queued = await GenerationJobManager.steering.peek(streamId);
    expect(queued).toHaveLength(1);
    expect(queued[0].text).toBe('focus on tests');
    expect(queued[0].clientSteerId).toBe('local-correlation-123');
    expect(queued[0].userId).toBe(user.id);
    expect(queued[0].files).toEqual([
      {
        file_id: 'f1',
        type: 'image/png',
        filepath: '/uploads/f1.png',
        filename: 'shot.png',
        height: 10,
        width: 20,
        bytes: 999,
        llmDeliveryPath: 'text',
      },
    ]);
  });

  it('normalizes quoted excerpts into the queue item like the chat route', async () => {
    const streamId = 'steer-req-quotes';
    await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { steerQuotesCapable: true },
    });

    const result = await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'about the selection',
      quotes: ['  kept excerpt  ', '', 42, 'second'],
    });

    expect(result.status).toBe(202);
    expect(result.body.quotesAccepted).toBe(true);
    const queued = await GenerationJobManager.steering.peek(streamId);
    expect(queued[0].quotes).toEqual(['kept excerpt', 'second']);
  });

  it('atomically strips quotes when a legacy HITL handover races the admission', async () => {
    // A resume keeps createdAt, so the enqueue fence cannot see the handover.
    // A LEGACY resumer rewrites providerExecutionId without knowing the quote
    // marker, which invalidates the previous owner's assertion; the enqueue
    // transaction evaluates that equality against the LIVE job — after the
    // admission's own capability read already said capable — and the returned
    // persisted item keeps the echo honest.
    const streamId = 'steer-req-quotes-downgrade';
    await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { steerQuotesCapable: true },
    });

    const result = await handleSteerRequest(
      user,
      { conversationId: streamId, text: 'about the selection', quotes: ['the excerpt'] },
      {
        checkAgentAccess: async () => {
          const stored = await GenerationJobManager.getJobStore().getJob(streamId);
          (stored as { providerExecutionId?: string }).providerExecutionId = 'legacy-resume-exec';
          return true;
        },
      },
    );

    expect(result.status).toBe(202);
    expect(result.body).not.toHaveProperty('quotesAccepted');
    const queued = await GenerationJobManager.steering.peek(streamId);
    expect(queued[0]).not.toHaveProperty('quotes');
  });

  it('drops quotes without the echo when the generation owner cannot merge them', async () => {
    // The job was created by a pre-quotes replica (no capability flag): an
    // upgraded admission replica must not store quotes its owning drain would
    // silently ignore — the missing echo makes the client re-stage them.
    const streamId = 'steer-req-quotes-incapable-owner';
    await GenerationJobManager.createJob(streamId, user.id);

    const result = await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'about the selection',
      quotes: ['the excerpt'],
    });

    expect(result.status).toBe(202);
    expect(result.body).not.toHaveProperty('quotesAccepted');
    const queued = await GenerationJobManager.steering.peek(streamId);
    expect(queued[0]).not.toHaveProperty('quotes');
  });

  it('omits quotes from the queue item when nothing usable was sent', async () => {
    const streamId = 'steer-req-no-quotes';
    await GenerationJobManager.createJob(streamId, user.id);

    const result = await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'plain steer',
      quotes: 'not-an-array',
    });

    expect(result.status).toBe(202);
    expect(result.body).not.toHaveProperty('quotesAccepted');
    const queued = await GenerationJobManager.steering.peek(streamId);
    expect(queued[0]).not.toHaveProperty('quotes');
  });

  describe('injected getFiles (owner-scoped resolve at enqueue)', () => {
    const dbDoc = {
      file_id: 'f1',
      type: 'image/png',
      filepath: '/uploads/u1/f1.png',
      filename: 'real.png',
      height: 4,
      width: 6,
      bytes: 111,
      llmDeliveryPath: 'text',
      user: 'user-1',
    } as unknown as IMongoFile;

    it('400s INVALID_FILES when any ref does not resolve to an owned doc, enqueuing nothing', async () => {
      const streamId = 'steer-req-file-foreign';
      await GenerationJobManager.createJob(streamId, user.id);
      const getFiles = jest.fn(async () => [dbDoc]);

      const result = await handleSteerRequest(
        user,
        {
          conversationId: streamId,
          text: 'x',
          files: [{ file_id: 'f1' }, { file_id: 'f-foreign' }],
        },
        { getFiles },
      );

      expect(result.status).toBe(400);
      expect(result.body.code).toBe('INVALID_FILES');
      expect(getFiles).toHaveBeenCalledWith(
        { file_id: { $in: ['f1', 'f-foreign'] }, user: user.id },
        {},
        {},
      );
      expect(await GenerationJobManager.steering.peek(streamId)).toEqual([]);
    });

    it('replaces client-supplied ref metadata with DB-derived shapes', async () => {
      const streamId = 'steer-req-file-trusted';
      await GenerationJobManager.createJob(streamId, user.id);
      const getFiles = jest.fn(async () => [dbDoc]);

      const result = await handleSteerRequest(
        user,
        {
          conversationId: streamId,
          text: 'trusted refs only',
          files: [
            {
              file_id: 'f1',
              type: 'text/html',
              filepath: 'https://evil.example/spoof',
              filename: 'spoof.html',
              bytes: 1,
            },
          ],
        },
        { getFiles },
      );

      expect(result.status).toBe(202);
      const queued = await GenerationJobManager.steering.peek(streamId);
      expect(queued[0].files).toEqual([
        {
          file_id: 'f1',
          type: 'image/png',
          filepath: '/uploads/u1/f1.png',
          filename: 'real.png',
          height: 4,
          width: 6,
          bytes: 111,
          llmDeliveryPath: 'text',
        },
      ]);
    });

    it('skips the resolve for text-only steers', async () => {
      const streamId = 'steer-req-file-none';
      await GenerationJobManager.createJob(streamId, user.id);
      const getFiles = jest.fn(async () => [dbDoc]);

      const result = await handleSteerRequest(
        user,
        { conversationId: streamId, text: 'no attachments' },
        { getFiles },
      );

      expect(result.status).toBe(202);
      expect(getFiles).not.toHaveBeenCalled();
    });

    it('409s when attachment resolution races the same generation into a pause', async () => {
      const streamId = 'steer-req-file-pause-race';
      const job = await GenerationJobManager.createJob(streamId, user.id);
      let signalResolveStarted: (() => void) | undefined;
      const resolveStarted = new Promise<void>((resolve) => {
        signalResolveStarted = resolve;
      });
      let releaseResolve: ((files: IMongoFile[]) => void) | undefined;
      const getFiles = jest.fn(
        () =>
          new Promise<IMongoFile[]>((resolve) => {
            releaseResolve = resolve;
            signalResolveStarted?.();
          }),
      );

      const requesting = handleSteerRequest(
        user,
        {
          conversationId: streamId,
          text: 'queue while approval is open',
          files: [{ file_id: 'f1' }],
        },
        { getFiles },
      );
      await resolveStarted;
      const action = buildPendingAction(
        buildToolApprovalPayload([
          { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call_pause_race' },
        ]),
        {
          streamId,
          conversationId: streamId,
          runId: 'run-pause-race',
          responseMessageId: 'msg-pause-race',
        },
      );
      await expect(GenerationJobManager.approvals.pause(streamId, action)).resolves.toBe(true);
      releaseResolve?.([dbDoc]);

      await expect(requesting).resolves.toEqual({
        status: 409,
        body: { code: 'RUN_PAUSED' },
      });
      await expect(GenerationJobManager.steering.peek(streamId, job.createdAt)).resolves.toEqual(
        [],
      );
    });
  });

  describe('injected updateFilesUsage (upload-window TTL parity)', () => {
    const dbDoc = { file_id: 'f1', type: 'image/png' } as unknown as IMongoFile;

    it('marks resolved uploads used after a successful enqueue', async () => {
      const streamId = 'steer-req-usage-ok';
      await GenerationJobManager.createJob(streamId, user.id);
      const getFiles = jest.fn(async () => [dbDoc]);
      const updateFilesUsage = jest.fn(async () => [dbDoc]);

      const result = await handleSteerRequest(
        user,
        { conversationId: streamId, text: 'x', files: [{ file_id: 'f1' }] },
        { getFiles, updateFilesUsage },
      );

      expect(result.status).toBe(202);
      expect(updateFilesUsage).toHaveBeenCalledWith([{ file_id: 'f1' }], undefined, {
        user: user.id,
        tenantId: undefined,
      });
    });

    it('does not enqueue when resolved upload retention fails', async () => {
      const streamId = 'steer-req-usage-deny';
      await GenerationJobManager.createJob(streamId, user.id);
      const getFiles = jest.fn(async () => [dbDoc]);
      const updateFilesUsage = jest.fn(async () => []);

      const denied = await handleSteerRequest(
        user,
        { conversationId: streamId, text: 'x', files: [{ file_id: 'f-unknown' }] },
        { getFiles, updateFilesUsage },
      );
      expect(denied.status).toBe(400);
      expect(updateFilesUsage).not.toHaveBeenCalled();

      const failing = jest.fn(async () => {
        throw new Error('usage write failed');
      });
      const accepted = await handleSteerRequest(
        user,
        { conversationId: streamId, text: 'x', files: [{ file_id: 'f1' }] },
        { getFiles, updateFilesUsage: failing },
      );
      expect(accepted).toEqual({
        status: 503,
        body: { code: 'STEER_FILE_RETENTION_FAILED' },
      });
      expect(failing).toHaveBeenCalledTimes(1);
      await expect(GenerationJobManager.steering.peek(streamId)).resolves.toEqual([]);

      const missing = await handleSteerRequest(
        user,
        { conversationId: streamId, text: 'x', files: [{ file_id: 'f1' }] },
        { getFiles, updateFilesUsage: jest.fn(async () => []) },
      );
      expect(missing).toEqual({
        status: 503,
        body: { code: 'STEER_FILE_RETENTION_FAILED' },
      });
      await expect(GenerationJobManager.steering.peek(streamId)).resolves.toEqual([]);
    });

    it('withholds a receipt replay until an older accepted steer file is retained', async () => {
      const streamId = 'steer-req-usage-replay';
      const clientSteerId = 'steer-usage-replay-client';
      await GenerationJobManager.createJob(streamId, user.id);
      const getFiles = jest.fn(async () => [dbDoc]);
      const retained = jest.fn(async () => [dbDoc]);
      const body = {
        conversationId: streamId,
        clientSteerId,
        text: 'x',
        files: [{ file_id: 'f1' }],
      };

      const accepted = await handleSteerRequest(user, body, {
        getFiles,
        updateFilesUsage: retained,
      });
      expect(accepted.status).toBe(202);

      const failedReplay = await handleSteerRequest(user, body, {
        getFiles,
        updateFilesUsage: jest.fn(async () => []),
      });
      expect(failedReplay).toEqual({
        status: 503,
        body: { code: 'STEER_FILE_RETENTION_FAILED' },
      });
      await expect(GenerationJobManager.steering.peek(streamId)).resolves.toHaveLength(1);

      const healedReplay = await handleSteerRequest(user, body, {
        getFiles,
        updateFilesUsage: retained,
      });
      expect(healedReplay).toEqual({
        status: 202,
        body: expect.objectContaining({ replayed: true, steerId: accepted.body.steerId }),
      });
    });
  });

  describe('injected checkAgentAccess (originating-run authorization)', () => {
    it('403s FORBIDDEN and enqueues nothing when the check denies', async () => {
      const streamId = 'steer-req-agent-denied';
      await GenerationJobManager.createJob(streamId, user.id);
      await GenerationJobManager.updateMetadata(streamId, {
        agent_id: 'agent_abc',
        endpoint: 'agents',
      });
      const checkAgentAccess = jest.fn(async () => false);
      const getFiles = jest.fn(async () => []);
      const updateFilesUsage = jest.fn(async () => []);

      const result = await handleSteerRequest(
        user,
        { conversationId: streamId, text: 'inject this', files: [{ file_id: 'f1' }] },
        { checkAgentAccess, getFiles, updateFilesUsage },
      );

      expect(result.status).toBe(403);
      expect(result.body.code).toBe('FORBIDDEN');
      expect(checkAgentAccess).toHaveBeenCalledWith({ agentId: 'agent_abc', endpoint: 'agents' });
      expect(getFiles).not.toHaveBeenCalled();
      expect(updateFilesUsage).not.toHaveBeenCalled();
      expect(await GenerationJobManager.steering.peek(streamId)).toEqual([]);
    });

    it('202s when the check allows, passing the job metadata identity', async () => {
      const streamId = 'steer-req-agent-allowed';
      await GenerationJobManager.createJob(streamId, user.id);
      const checkAgentAccess = jest.fn(async () => true);

      const result = await handleSteerRequest(
        user,
        { conversationId: streamId, text: 'go ahead' },
        { checkAgentAccess },
      );

      expect(result.status).toBe(202);
      // No metadata written yet — the callback still receives the (empty) identity.
      expect(checkAgentAccess).toHaveBeenCalledWith({ agentId: undefined, endpoint: undefined });
      expect(await GenerationJobManager.steering.peek(streamId)).toHaveLength(1);
    });

    it('409s when the run is replaced while the agent access check is in flight', async () => {
      const streamId = 'steer-req-agent-replacement-race';
      const original = await GenerationJobManager.createJob(streamId, user.id);
      let signalAccessStarted: (() => void) | undefined;
      const accessStarted = new Promise<void>((resolve) => {
        signalAccessStarted = resolve;
      });
      let releaseAccess: ((allowed: boolean) => void) | undefined;
      const checkAgentAccess = jest.fn(
        () =>
          new Promise<boolean>((resolve) => {
            releaseAccess = resolve;
            signalAccessStarted?.();
          }),
      );

      const requesting = handleSteerRequest(
        user,
        { conversationId: streamId, text: 'belongs after the newer run' },
        { checkAgentAccess },
      );
      await accessStarted;
      const replacement = await GenerationJobManager.createJob(streamId, user.id);
      expect(replacement.createdAt).not.toBe(original.createdAt);
      releaseAccess?.(true);

      await expect(requesting).resolves.toEqual({
        status: 409,
        body: { code: 'RUN_REPLACED' },
      });
      await expect(
        GenerationJobManager.steering.peek(streamId, replacement.createdAt),
      ).resolves.toEqual([]);
    });
  });
});

describe('generation protocol bridge for steering mutations', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSupported.mockReturnValue(true);
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  it('caps a v2 request to a v1 job and uses only legacy queue/update surfaces', async () => {
    const streamId = 'steer-protocol-v1-job';
    await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: {
        generationProtocolVersion: 1,
        preemptCapable: true,
      },
    });
    const receiptRead = jest.spyOn(GenerationJobManager.steering, 'getReceipt');
    const receiptEnqueue = jest.spyOn(GenerationJobManager.steering, 'enqueueWithReceipt');
    const legacyEnqueue = jest.spyOn(GenerationJobManager.steering, 'enqueueVersioned');
    const publishUpdate = jest.spyOn(GenerationJobManager, 'emitChunkFromAnyReplica');

    const result = await handleSteerRequest(
      user,
      {
        conversationId: streamId,
        clientSteerId: 'client-v1-steer',
        text: 'legacy-safe instruction',
        preempt: true,
      },
      { generationProtocolVersion: 2 },
    );

    expect(result).toEqual({
      status: 202,
      body: {
        status: 'queued',
        steerId: expect.any(String),
        position: 1,
        conversationId: streamId,
        preempt: true,
        generationProtocolVersion: 1,
      },
    });
    /** Host-v2 performs a read-only lookup before the current v1 marker can
     * cap the request, because an older v2 receipt may outlive this job. */
    expect(receiptRead).toHaveBeenCalledTimes(1);
    expect(receiptEnqueue).not.toHaveBeenCalled();
    expect(legacyEnqueue).toHaveBeenCalledTimes(1);
    expect(publishUpdate).not.toHaveBeenCalled();
    await expect(GenerationJobManager.steering.peek(streamId)).resolves.toEqual([
      expect.not.objectContaining({ clientSteerId: expect.anything() }),
    ]);
  });

  it('rejects a v1 job before enqueue when the caller requires idempotent delivery', async () => {
    const streamId = 'steer-protocol-v1-idempotency-required';
    await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 1 },
    });
    const receiptEnqueue = jest.spyOn(GenerationJobManager.steering, 'enqueueWithReceipt');
    const legacyEnqueue = jest.spyOn(GenerationJobManager.steering, 'enqueueVersioned');

    const result = await handleSteerRequest(
      user,
      {
        conversationId: streamId,
        clientSteerId: 'client-v1-requires-idempotency',
        text: 'must not be injected without a receipt',
      },
      { generationProtocolVersion: 2, requireIdempotentDelivery: true },
    );

    expect(result).toEqual({
      status: 409,
      body: { code: 'STEER_IDEMPOTENCY_UNAVAILABLE', generationProtocolVersion: 1 },
    });
    expect(receiptEnqueue).not.toHaveBeenCalled();
    expect(legacyEnqueue).not.toHaveBeenCalled();
    await expect(GenerationJobManager.steering.peek(streamId)).resolves.toEqual([]);
  });

  it('keeps ownership rejection ahead of the strict idempotency capability gate', async () => {
    const streamId = 'steer-protocol-v1-idempotency-foreign-owner';
    await GenerationJobManager.createJob(streamId, 'someone-else', undefined, {
      initialMetadata: { generationProtocolVersion: 1 },
    });

    const result = await handleSteerRequest(
      user,
      {
        conversationId: streamId,
        clientSteerId: 'client-v1-foreign-owner',
        text: 'must remain unauthorized',
      },
      { generationProtocolVersion: 2, requireIdempotentDelivery: true },
    );

    expect(result).toEqual({
      status: 403,
      body: { code: 'UNAUTHORIZED', generationProtocolVersion: 1 },
    });
    await expect(GenerationJobManager.steering.peek(streamId)).resolves.toEqual([]);
  });

  it('observes delivery cancellation after async admission and before enqueue', async () => {
    const streamId = 'steer-protocol-v2-aborted-admission';
    await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: {
        agent_id: 'agent-1',
        endpoint: 'agents',
        generationProtocolVersion: 2,
      },
    });
    const controller = new AbortController();
    const receiptEnqueue = jest.spyOn(GenerationJobManager.steering, 'enqueueWithReceipt');

    const result = await handleSteerRequest(
      user,
      {
        conversationId: streamId,
        clientSteerId: 'client-v2-aborted-admission',
        text: 'must not land after the worker lease is cancelled',
      },
      {
        generationProtocolVersion: 2,
        requireIdempotentDelivery: true,
        signal: controller.signal,
        checkAgentAccess: async () => {
          controller.abort();
          return true;
        },
      },
    );

    expect(result).toEqual({
      status: 499,
      body: { code: 'STEER_ABORTED', generationProtocolVersion: 2 },
    });
    expect(receiptEnqueue).not.toHaveBeenCalled();
    await expect(GenerationJobManager.steering.peek(streamId)).resolves.toEqual([]);
  });

  it('keeps v2 receipt replay and correlation broadcasts behind an exact v2 job marker', async () => {
    const streamId = 'steer-protocol-v2-job';
    await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const receiptEnqueue = jest.spyOn(GenerationJobManager.steering, 'enqueueWithReceipt');
    const publishUpdate = jest
      .spyOn(GenerationJobManager, 'emitChunkFromAnyReplica')
      .mockResolvedValue(true);
    const requestBody = {
      conversationId: streamId,
      clientSteerId: 'client-v2-steer',
      text: 'receipt-safe instruction',
    };

    const accepted = await handleSteerRequest(user, requestBody, {
      generationProtocolVersion: 2,
    });
    const replayed = await handleSteerRequest(user, requestBody, {
      generationProtocolVersion: 2,
    });

    expect(accepted.body).toMatchObject({
      status: 'queued',
      generationProtocolVersion: 2,
    });
    expect(replayed.body).toMatchObject({
      steerId: accepted.body.steerId,
      replayed: true,
      generationProtocolVersion: 2,
    });
    expect(receiptEnqueue).toHaveBeenCalledTimes(1);
    expect(publishUpdate).toHaveBeenCalledTimes(1);
  });

  it('keeps receipt fingerprints quote-independent so legacy replicas can replay them', async () => {
    // The 3-field hash is the one shape EVERY deployed version computes: a
    // lost-ACK retry of a quoted steer routed through a pre-quotes replica
    // must replay the receipt, not 409 accepted words as a conflict.
    const streamId = 'steer-protocol-v2-legacy-replayable';
    await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 2, steerQuotesCapable: true },
    });
    const base = { conversationId: streamId, text: 'identical words' };

    await handleSteerRequest(
      user,
      { ...base, clientSteerId: 'client-quoted', quotes: ['the excerpt'] },
      { generationProtocolVersion: 2 },
    );
    await handleSteerRequest(
      user,
      { ...base, clientSteerId: 'client-plain' },
      { generationProtocolVersion: 2 },
    );

    const quoted = await GenerationJobManager.steering.getReceipt(streamId, 'client-quoted');
    const plain = await GenerationJobManager.steering.getReceipt(streamId, 'client-plain');
    expect(quoted?.fingerprint).toBe(plain?.fingerprint);
    expect(typeof quoted?.requestedQuotesFingerprint).toBe('string');
    expect(plain?.requestedQuotesFingerprint).toBeUndefined();
  });

  it('keeps receipt fingerprints stable when display delivery metadata is added', async () => {
    const streamId = 'steer-protocol-v2-delivery-path-fingerprint';
    await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const base = {
      conversationId: streamId,
      text: 'same attachment steer',
      files: [{ file_id: 'f1', type: 'application/pdf', filename: 'report.pdf' }],
    };

    await handleSteerRequest(
      user,
      { ...base, clientSteerId: 'client-legacy-file-ref' },
      {
        generationProtocolVersion: 2,
      },
    );
    await handleSteerRequest(
      user,
      {
        ...base,
        clientSteerId: 'client-current-file-ref',
        files: [{ ...base.files[0], llmDeliveryPath: 'text' }],
      },
      { generationProtocolVersion: 2 },
    );

    const legacy = await GenerationJobManager.steering.getReceipt(
      streamId,
      'client-legacy-file-ref',
    );
    const current = await GenerationJobManager.steering.getReceipt(
      streamId,
      'client-current-file-ref',
    );
    expect(current?.fingerprint).toBe(legacy?.fingerprint);
    for (const [clientSteerId, files] of [
      ['client-legacy-file-ref', [{ ...base.files[0], llmDeliveryPath: 'text' }]],
      ['client-current-file-ref', base.files],
    ] as const) {
      const replay = await handleSteerRequest(
        user,
        { ...base, clientSteerId, files },
        { generationProtocolVersion: 2 },
      );
      expect(replay.body).toMatchObject({ replayed: true });
    }
    expect(await GenerationJobManager.steering.peek(streamId)).toHaveLength(2);
  });

  it('treats quotes as part of the idempotency identity', async () => {
    const streamId = 'steer-protocol-v2-quote-fingerprint';
    await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 2, steerQuotesCapable: true },
    });
    const requestBody = {
      conversationId: streamId,
      clientSteerId: 'client-v2-quoted',
      text: 'about this excerpt',
      quotes: ['the excerpt'],
    };

    const accepted = await handleSteerRequest(user, requestBody, {
      generationProtocolVersion: 2,
    });
    const replayed = await handleSteerRequest(user, requestBody, {
      generationProtocolVersion: 2,
    });
    const conflicting = await handleSteerRequest(
      user,
      { ...requestBody, quotes: ['a different excerpt'] },
      { generationProtocolVersion: 2 },
    );

    expect(accepted.status).toBe(202);
    expect(accepted.body.quotesAccepted).toBe(true);
    expect(replayed.body).toMatchObject({
      steerId: accepted.body.steerId,
      replayed: true,
      // Echoed from the durable item so a lost-ACK retry still learns the
      // excerpts were attached to the accepted words.
      quotesAccepted: true,
    });
    expect(conflicting.status).toBe(409);
    expect(conflicting.body.code).toBe('STEER_IDEMPOTENCY_CONFLICT');
  });

  it('replays a legacy quote-less receipt for a quoted retry of the same words', async () => {
    // Cross-version lost ACK: a pre-quotes replica accepted the words and its
    // receipt hashes only text/files/preempt. The retry now carries quotes —
    // it must replay that receipt (the words are already durable) and OMIT the
    // quotesAccepted echo so the client re-stages the dropped excerpts.
    const streamId = 'steer-protocol-v2-legacy-fingerprint';
    await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const requestBody = {
      conversationId: streamId,
      clientSteerId: 'client-v2-legacy-quoted',
      text: 'same accepted words',
    };
    const receiptEnqueue = jest.spyOn(GenerationJobManager.steering, 'enqueueWithReceipt');

    const accepted = await handleSteerRequest(user, requestBody, {
      generationProtocolVersion: 2,
    });
    const quotedRetry = await handleSteerRequest(
      user,
      { ...requestBody, quotes: ['the excerpt'] },
      { generationProtocolVersion: 2 },
    );

    expect(accepted.status).toBe(202);
    expect(quotedRetry.status).toBe(202);
    expect(quotedRetry.body).toMatchObject({ steerId: accepted.body.steerId, replayed: true });
    expect(quotedRetry.body).not.toHaveProperty('quotesAccepted');
    expect(receiptEnqueue).toHaveBeenCalledTimes(1);
  });

  it('replays a v2 receipt after terminal cleanup deletes the accepting job', async () => {
    const streamId = 'steer-protocol-v2-replay-after-delete';
    const job = await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const requestBody = {
      conversationId: streamId,
      generationCreatedAt: job.createdAt,
      clientSteerId: 'client-v2-after-delete',
      text: 'accept exactly once',
    };
    const receiptEnqueue = jest.spyOn(GenerationJobManager.steering, 'enqueueWithReceipt');

    const accepted = await handleSteerRequest(user, requestBody, {
      generationProtocolVersion: 2,
    });
    await GenerationJobManager.getJobStore().deleteJob(streamId, job.createdAt);
    const replayed = await handleSteerRequest(user, requestBody, {
      generationProtocolVersion: 2,
    });

    expect(replayed).toEqual({
      status: 202,
      body: {
        status: 'queued',
        steerId: accepted.body.steerId,
        position: 1,
        conversationId: streamId,
        preempt: false,
        settled: true,
        leftover: true,
        replayed: true,
        generationProtocolVersion: 2,
      },
    });
    expect(receiptEnqueue).toHaveBeenCalledTimes(1);
  });

  it('does not let a later v1 job hide an earlier v2 receipt', async () => {
    const streamId = 'steer-protocol-v2-replay-over-v1';
    const original = await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const requestBody = {
      conversationId: streamId,
      generationCreatedAt: original.createdAt,
      clientSteerId: 'client-v2-before-v1',
      text: 'keep the original acceptance',
    };
    const receiptEnqueue = jest.spyOn(GenerationJobManager.steering, 'enqueueWithReceipt');
    const accepted = await handleSteerRequest(user, requestBody, {
      generationProtocolVersion: 2,
    });

    const replacement = await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 1 },
    });
    expect(replacement.createdAt).not.toBe(original.createdAt);
    const replayed = await handleSteerRequest(user, requestBody, {
      generationProtocolVersion: 2,
    });

    expect(replayed.body).toMatchObject({
      steerId: accepted.body.steerId,
      replayed: true,
      settled: true,
      leftover: true,
      generationProtocolVersion: 2,
    });
    expect(receiptEnqueue).toHaveBeenCalledTimes(1);
    await expect(
      GenerationJobManager.steering.peek(streamId, replacement.createdAt),
    ).resolves.toEqual([]);
  });

  it('rejects receipt replay for a different explicit generation', async () => {
    const streamId = 'steer-protocol-v2-replay-generation-fence';
    const job = await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const requestBody = {
      conversationId: streamId,
      generationCreatedAt: job.createdAt,
      clientSteerId: 'client-v2-generation-fence',
      text: 'generation-bound acceptance',
    };
    await handleSteerRequest(user, requestBody, { generationProtocolVersion: 2 });
    await GenerationJobManager.getJobStore().deleteJob(streamId, job.createdAt);

    const stale = await handleSteerRequest(
      user,
      { ...requestBody, generationCreatedAt: job.createdAt + 1 },
      { generationProtocolVersion: 2 },
    );

    expect(stale).toEqual({
      status: 409,
      body: { code: 'RUN_REPLACED', generationProtocolVersion: 2 },
    });
  });

  it('replays a committed receipt even if mutable agent access is later revoked', async () => {
    const streamId = 'steer-protocol-v2-replay-after-revocation';
    await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: {
        generationProtocolVersion: 2,
        agent_id: 'agent-replay',
        endpoint: 'agents',
      },
    });
    const requestBody = {
      conversationId: streamId,
      clientSteerId: 'client-v2-after-revocation',
      text: 'already accepted instruction',
    };
    const checkAgentAccess = jest.fn().mockResolvedValueOnce(true).mockResolvedValue(false);

    const accepted = await handleSteerRequest(user, requestBody, {
      generationProtocolVersion: 2,
      checkAgentAccess,
    });
    const replayed = await handleSteerRequest(user, requestBody, {
      generationProtocolVersion: 2,
      checkAgentAccess,
    });

    expect(replayed).toEqual({
      status: 202,
      body: expect.objectContaining({
        steerId: accepted.body.steerId,
        replayed: true,
        generationProtocolVersion: 2,
      }),
    });
    expect(checkAgentAccess).toHaveBeenCalledTimes(1);
    await expect(GenerationJobManager.steering.peek(streamId)).resolves.toHaveLength(1);
  });

  it('treats a missing job marker and an explicitly malformed package cap as v1', async () => {
    const streamId = 'steer-protocol-missing-marker';
    await GenerationJobManager.createJob(streamId, user.id);
    const stored = await GenerationJobManager.getJobStore().getJob(streamId);
    expect(stored).not.toBeNull();
    delete (stored as { generationProtocolVersion?: number }).generationProtocolVersion;
    const receiptRead = jest.spyOn(GenerationJobManager.steering, 'getReceipt');

    const missingMarker = await handleSteerRequest(
      user,
      { conversationId: streamId, clientSteerId: 'missing-marker-id', text: 'safe fallback' },
      { generationProtocolVersion: 2 },
    );
    const malformedCap = await handleSteerRequest(
      user,
      { conversationId: 'invalid-cap-target', text: 'no live job' },
      { generationProtocolVersion: 9 } as unknown as { generationProtocolVersion: 2 },
    );

    expect(missingMarker.body.generationProtocolVersion).toBe(1);
    expect(malformedCap.body.generationProtocolVersion).toBe(1);
    expect(receiptRead).toHaveBeenCalledTimes(1);
  });

  it('keeps v1 cancel and arm off receipt mutations and versioned updates', async () => {
    const streamId = 'steer-protocol-v1-mutations';
    await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 1, preemptCapable: true },
    });
    const queued = await handleSteerRequest(
      user,
      { conversationId: streamId, clientSteerId: 'v1-mutation-id', text: 'queue then arm' },
      { generationProtocolVersion: 2 },
    );
    const steerId = queued.body.steerId as string;
    const receiptRead = jest.spyOn(GenerationJobManager.steering, 'getReceipt');
    const discardLeftover = jest.spyOn(GenerationJobManager.steering, 'discardLeftover');
    const legacyArm = jest.spyOn(GenerationJobManager.steering, 'arm');
    const versionedArm = jest.spyOn(GenerationJobManager.steering, 'armVersioned');
    const publishUpdate = jest.spyOn(GenerationJobManager, 'emitChunkFromAnyReplica');
    const requestPreempt = jest.spyOn(GenerationJobManager, 'requestPreempt');

    const armed = await handleSteerArm(
      user,
      { conversationId: streamId, steerId },
      { generationProtocolVersion: 2 },
    );
    const cancelled = await handleSteerCancel(
      user,
      { conversationId: streamId, steerId, clientSteerId: 'v1-mutation-id' },
      { generationProtocolVersion: 2 },
    );

    expect(armed).toEqual({
      status: 200,
      body: { armed: true, generationProtocolVersion: 1 },
    });
    expect(cancelled).toEqual({
      status: 200,
      body: { removed: true, generationProtocolVersion: 1 },
    });
    /** The v2 host probes once for an older v2 receipt before the current
     * v1 job caps mutation semantics. This v1 enqueue created no receipt, so
     * the probe cannot mutate or replay anything. */
    expect(receiptRead).toHaveBeenCalledTimes(1);
    expect(receiptRead).toHaveBeenCalledWith(streamId, 'v1-mutation-id');
    expect(discardLeftover).not.toHaveBeenCalled();
    expect(legacyArm).not.toHaveBeenCalled();
    expect(versionedArm).toHaveBeenCalledTimes(1);
    expect(requestPreempt).toHaveBeenCalledWith(streamId, steerId, expect.any(Number), 1);
    expect(publishUpdate).not.toHaveBeenCalled();
  });
});

describe('handleSteerCancel (real in-memory job manager)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSupported.mockReturnValue(true);
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  async function queueSteer(streamId: string): Promise<string> {
    await GenerationJobManager.createJob(streamId, 'user-1');
    const result = await handleSteerRequest(user, { conversationId: streamId, text: 'cancel me' });
    expect(result.status).toBe(202);
    return result.body.steerId as string;
  }

  it('400s on invalid input', async () => {
    expect((await handleSteerCancel(user, { steerId: 's1' })).status).toBe(400);
    const badId = await handleSteerCancel(user, { conversationId: 'c1', steerId: '' });
    expect(badId.status).toBe(400);
    expect(badId.body.code).toBe('INVALID_STEER_ID');
  });

  it('409s a cancel targeting a replaced generation and leaves the live queue intact', async () => {
    const streamId = 'cancel-stale-generation';
    const steerId = await queueSteer(streamId);
    const live = await GenerationJobManager.getJob(streamId);

    const result = await handleSteerCancel(user, {
      conversationId: streamId,
      generationCreatedAt: (live?.createdAt as number) - 1,
      steerId,
    });

    expect(result).toEqual({ status: 409, body: { code: 'RUN_REPLACED' } });
    await expect(GenerationJobManager.steering.peek(streamId)).resolves.toHaveLength(1);
  });

  it('removes a queued steer and reports a lost race as removed:false', async () => {
    const steerId = await queueSteer('cancel-ok');
    const cancelled = await handleSteerCancel(user, { conversationId: 'cancel-ok', steerId });
    expect(cancelled).toEqual({ status: 200, body: { removed: true } });
    expect(await GenerationJobManager.steering.peek('cancel-ok')).toEqual([]);

    const again = await handleSteerCancel(user, { conversationId: 'cancel-ok', steerId });
    expect(again).toEqual({ status: 200, body: { removed: false } });
  });

  it('replays a successful receipt-backed cancel when the first response was lost', async () => {
    const streamId = 'cancel-replay';
    const clientSteerId = 'cancel-replay-client';
    await GenerationJobManager.createJob(streamId, 'user-1');
    const queued = await handleSteerRequest(user, {
      conversationId: streamId,
      clientSteerId,
      text: 'cancel exactly once',
    });
    const steerId = queued.body.steerId as string;

    const first = await handleSteerCancel(user, {
      conversationId: streamId,
      steerId,
      clientSteerId,
    });
    expect(first).toEqual({ status: 200, body: { removed: true } });

    const replay = await handleSteerCancel(user, {
      conversationId: streamId,
      steerId,
      clientSteerId,
    });
    expect(replay).toEqual({ status: 200, body: { removed: true, replayed: true } });
    await expect(
      GenerationJobManager.steering.getReceipt(streamId, clientSteerId),
    ).resolves.toMatchObject({
      state: 'cancelled',
    });
  });

  it('reclaims a queued receipt that becomes leftover before the job lookup', async () => {
    const streamId = 'cancel-terminal-race';
    const clientSteerId = 'cancel-terminal-race-client';
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const queued = await handleSteerRequest(user, {
      conversationId: streamId,
      clientSteerId,
      text: 'do not revive me',
    });
    const steerId = queued.body.steerId as string;
    const jobStore = GenerationJobManager.getJobStore();
    const getJobSpy = jest
      .spyOn(GenerationJobManager, 'getJob')
      .mockImplementationOnce(async () => {
        await jobStore.closeAndDrainSteers(streamId, job.createdAt);
        await jobStore.deleteJob(streamId, job.createdAt);
        return undefined;
      });

    try {
      const cancelled = await handleSteerCancel(user, {
        conversationId: streamId,
        steerId,
        clientSteerId,
      });

      expect(cancelled).toEqual({ status: 200, body: { removed: true, replayed: true } });
      await expect(
        GenerationJobManager.steering.getReceipt(streamId, clientSteerId),
      ).resolves.toMatchObject({
        state: 'cancelled',
      });
      await expect(
        GenerationJobManager.steering.claim(streamId, { userId: 'user-1' }),
      ).resolves.toEqual([]);
    } finally {
      getJobSpy.mockRestore();
    }
  });

  it('does not settle a terminal receipt from a different explicit generation', async () => {
    const streamId = 'cancel-terminal-replaced-receipt';
    const clientSteerId = 'cancel-terminal-replaced-receipt-client';
    const job = await GenerationJobManager.createJob(streamId, 'user-1');
    const queued = await handleSteerRequest(user, {
      conversationId: streamId,
      generationCreatedAt: job.createdAt,
      clientSteerId,
      text: 'belongs to the newer generation',
    });
    const steerId = queued.body.steerId as string;
    const jobStore = GenerationJobManager.getJobStore();
    await jobStore.closeAndDrainSteers(streamId, job.createdAt);
    await jobStore.deleteJob(streamId, job.createdAt);

    const result = await handleSteerCancel(user, {
      conversationId: streamId,
      generationCreatedAt: job.createdAt - 1,
      steerId,
      clientSteerId,
    });

    expect(result).toEqual({ status: 409, body: { code: 'RUN_REPLACED' } });
    await expect(
      GenerationJobManager.steering.getReceipt(streamId, clientSteerId),
    ).resolves.toMatchObject({ state: 'leftover', generationCreatedAt: job.createdAt });
    await expect(
      GenerationJobManager.steering.claim(streamId, { userId: 'user-1' }),
    ).resolves.toEqual([expect.objectContaining({ steerId })]);
  });

  it('discards an older v2 leftover even when the current replacement job is v1', async () => {
    const streamId = 'cancel-v2-leftover-after-v1-replacement';
    const clientSteerId = 'cancel-v2-leftover-client';
    const predecessor = await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 2 },
    });
    const queued = await handleSteerRequest(
      user,
      {
        conversationId: streamId,
        generationCreatedAt: predecessor.createdAt,
        clientSteerId,
        text: 'do not recover this',
      },
      { generationProtocolVersion: 2 },
    );
    const steerId = queued.body.steerId as string;
    await expect(
      GenerationJobManager.completeJob(streamId, undefined, predecessor.createdAt),
    ).resolves.toBe(true);
    const replacement = await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 1 },
    });

    const result = await handleSteerCancel(
      user,
      {
        conversationId: streamId,
        generationCreatedAt: predecessor.createdAt,
        steerId,
        clientSteerId,
      },
      { generationProtocolVersion: 2 },
    );

    expect(result).toEqual({
      status: 200,
      body: { removed: true, replayed: true, generationProtocolVersion: 2 },
    });
    await expect(
      GenerationJobManager.steering.getReceipt(streamId, clientSteerId),
    ).resolves.toMatchObject({
      state: 'cancelled',
      generationCreatedAt: predecessor.createdAt,
    });
    await expect(GenerationJobManager.getJob(streamId)).resolves.toMatchObject({
      status: 'running',
      createdAt: replacement.createdAt,
      metadata: { generationProtocolVersion: 1 },
    });
  });

  it('treats a missing job as a lost race, not an error', async () => {
    const result = await handleSteerCancel(user, { conversationId: 'gone', steerId: 's1' });
    expect(result).toEqual({ status: 200, body: { removed: false } });
  });

  /**
   * ioredis queues commands during an outage instead of rejecting, so an
   * unbounded wait on the disarm publish can hang for the length of the
   * outage — with the steer already durably cancelled. A client that gives up
   * treats the cancel as failed and restores a chip for a steer that can
   * never produce an applied event.
   */
  it('answers the cancel even when the disarm publish never settles', async () => {
    const steerId = await queueSteer('cancel-stalled-disarm');
    let release: (() => void) | undefined;
    const spy = jest.spyOn(GenerationJobManager, 'noteSteersRemoved').mockReturnValue(
      new Promise<boolean>((resolve) => {
        release = () => resolve(true);
      }),
    );

    try {
      const result = await handleSteerCancel(user, {
        conversationId: 'cancel-stalled-disarm',
        steerId,
      });

      expect(result).toEqual({ status: 200, body: { removed: true } });
      expect(spy).toHaveBeenCalledWith('cancel-stalled-disarm', [steerId], expect.any(Number));
      /** Durably gone regardless — the wait was only ever a head start. */
      expect(await GenerationJobManager.steering.peek('cancel-stalled-disarm')).toEqual([]);
    } finally {
      release?.();
      spy.mockRestore();
    }
  }, 10000);

  it('403s another user and leaves the steer queued', async () => {
    const steerId = await queueSteer('cancel-foreign');
    const result = await handleSteerCancel(
      { id: 'intruder' },
      { conversationId: 'cancel-foreign', steerId },
    );
    expect(result.status).toBe(403);
    expect((await GenerationJobManager.steering.peek('cancel-foreign')).length).toBe(1);
  });

  it('fails closed when the stored job owner is missing', async () => {
    const streamId = 'cancel-missing-owner';
    const steerId = await queueSteer(streamId);
    await removeStoredJobOwner(streamId);

    const result = await handleSteerCancel(user, { conversationId: streamId, steerId });

    expect(result).toEqual({ status: 403, body: { code: 'UNAUTHORIZED' } });
    await expect(GenerationJobManager.steering.peek(streamId)).resolves.toHaveLength(1);
  });
});

describe('preempt flag on the steer request', () => {
  /** The owning replica records its own seal capability at createJob; the
   *  route honours that rather than probing its own SDK. */
  function createCapableJob(streamId: string) {
    return GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { preemptCapable: true },
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSupported.mockReturnValue(true);
    mockIsPreemptSupported.mockReturnValue(true);
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  it('arms the request, marks the queued item, and echoes preempt: true', async () => {
    const streamId = 'preempt-req-armed';
    await createCapableJob(streamId);

    const result = await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'stop and do this instead',
      preempt: true,
    });

    expect(result.status).toBe(202);
    expect(result.body.preempt).toBe(true);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(true);
    expect((await GenerationJobManager.steering.peek(streamId))[0].preempt).toBe(true);
  });

  it('omits the flag for an ordinary steer and never arms', async () => {
    const streamId = 'preempt-req-plain';
    await GenerationJobManager.createJob(streamId, user.id);

    const result = await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'ordinary steer',
    });

    expect(result.status).toBe(202);
    expect(result.body.preempt).toBe(false);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
    expect((await GenerationJobManager.steering.peek(streamId))[0].preempt).toBeUndefined();
  });

  /**
   * The guard ladder — ownership, tenant, paused-state, agent ACL — runs
   * against the job read at the top. The owner re-read happens several awaits
   * later and can cross a replacement, so a different generation there is a
   * run this request was never authorized against. Accepting into it would
   * carry the wrong agent's metadata.
   */
  it('refuses when the run is replaced between the guards and the owner re-read', async () => {
    const streamId = 'preempt-req-replaced-midflight';
    const original = await createCapableJob(streamId);
    const originalSnapshot = await GenerationJobManager.getJob(streamId);
    /** The run is genuinely replaced, so the owner re-read returns a REAL
     *  live generation — an enqueue fenced to it would succeed. */
    const replacement = await createCapableJob(streamId);
    expect(replacement.createdAt).not.toBe(original.createdAt);

    const realGetJob = GenerationJobManager.getJob.bind(GenerationJobManager);
    let calls = 0;
    const spy = jest
      .spyOn(GenerationJobManager, 'getJob')
      .mockImplementation(async (id: string) => {
        calls += 1;
        /** The guard ladder ran before the replacement; the owner re-read after. */
        return calls === 1 ? originalSnapshot : realGetJob(id);
      });

    try {
      const result = await handleSteerRequest(user, {
        conversationId: streamId,
        text: 'interrupt me',
        preempt: true,
      });

      expect(result.status).toBe(409);
      expect(result.body.code).toBe('RUN_REPLACED');
      /** Nothing reached the replacement's queue. */
      expect(await GenerationJobManager.steering.peek(streamId)).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });

  /**
   * The queue item is already durable by the time the arm is published, and
   * the 202 reports capability rather than delivery — so waiting on a stalled
   * Redis buys nothing and risks the caller timing out and retrying, which
   * would mint a SECOND steer alongside the first and inject the same
   * instruction twice. If this ever awaits again, this test times out.
   */
  it('does not hold the 202 behind a stalled preempt publish', async () => {
    const streamId = 'preempt-req-stalled-publish';
    await createCapableJob(streamId);

    let release: (() => void) | undefined;
    const neverSettles = new Promise<boolean>((resolve) => {
      release = () => resolve(true);
    });
    const spy = jest.spyOn(GenerationJobManager, 'requestPreempt').mockReturnValue(neverSettles);

    try {
      const result = await handleSteerRequest(user, {
        conversationId: streamId,
        text: 'interrupt me',
        preempt: true,
      });

      expect(result.status).toBe(202);
      expect(result.body.preempt).toBe(true);
      expect(spy).toHaveBeenCalledWith(streamId, expect.any(String), expect.any(Number), 1);
      /** Still durable, so the boundary drain will find it either way. */
      expect((await GenerationJobManager.steering.peek(streamId))[0].preempt).toBe(true);
    } finally {
      release?.();
      spy.mockRestore();
    }
  });

  /**
   * The mirror of the owner-incapable case below, and the direction a local
   * probe used to get wrong: during a rolling deploy the steer can land on an
   * un-upgraded replica while a capable replica owns the generation. The
   * route never seals — it enqueues and publishes an arm — so its own SDK is
   * irrelevant and dropping the interrupt here would lose it for no reason.
   */
  it('honours a capable OWNER even when the routing replica cannot seal', async () => {
    mockIsPreemptSupported.mockReturnValue(false);
    const streamId = 'preempt-req-old-router';
    await createCapableJob(streamId);

    const result = await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'interrupt me',
      preempt: true,
    });

    expect(result.status).toBe(202);
    expect(result.body.preempt).toBe(true);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(true);
    expect((await GenerationJobManager.steering.peek(streamId))[0].preempt).toBe(true);
  });

  /**
   * Rolling deploy: the route replica can seal but the replica that OWNS the
   * generation cannot. Labelling it "interrupting" would lie.
   */
  it('degrades when the OWNING replica recorded no seal capability', async () => {
    const streamId = 'preempt-req-old-owner';
    await GenerationJobManager.createJob(streamId, user.id);

    const result = await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'interrupt me',
      preempt: true,
    });

    expect(result.status).toBe(202);
    expect(result.body.preempt).toBe(false);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
  });

  it('does not arm when the enqueue itself is rejected', async () => {
    const streamId = 'preempt-req-full';
    await createCapableJob(streamId);
    for (let i = 0; i < STEER_QUEUE_MAX_DEPTH; i++) {
      await GenerationJobManager.steering.enqueue(streamId, {
        steerId: `filler-${i}`,
        text: `filler ${i}`,
        userId: user.id,
        createdAt: Date.now(),
      });
    }

    const result = await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'too late',
      preempt: true,
    });

    expect(result.status).toBe(429);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
  });

  /**
   * Cancel is live UI. Without this the request stays armed after its steer
   * is gone and seals an unrelated stretch of generation.
   */
  /**
   * Option A semantics: the 202's `preempt` mirrors the DURABLE queue flag,
   * so the response and `SteerQueueItem.preempt` can never disagree — a
   * resumed owner re-arming from the queue then honours exactly what the
   * client was told.
   */
  it('the 202 flag and the durable queue item always agree', async () => {
    const streamId = 'preempt-flag-agrees';
    await createCapableJob(streamId);

    const result = await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'interrupt me',
      preempt: true,
    });
    const queued = (await GenerationJobManager.steering.peek(streamId))[0];

    expect(result.body.preempt).toBe(true);
    expect(queued.preempt).toBe(true);
    expect(result.body.preempt).toBe(queued.preempt === true);
  });

  it('cancelling a preempt steer disarms the request', async () => {
    const streamId = 'preempt-req-cancel';
    await createCapableJob(streamId);
    const queued = await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'never mind',
      preempt: true,
    });
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(true);

    const cancelled = await handleSteerCancel(user, {
      conversationId: streamId,
      steerId: queued.body.steerId,
    });

    expect(cancelled.body.removed).toBe(true);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
  });

  it('a lost cancel race leaves the surviving request armed', async () => {
    const streamId = 'preempt-req-cancel-miss';
    await createCapableJob(streamId);
    await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'still queued',
      preempt: true,
    });

    const cancelled = await handleSteerCancel(user, {
      conversationId: streamId,
      steerId: 'never-existed',
    });

    expect(cancelled.body.removed).toBe(false);
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(true);
  });
});

/**
 * Escalation of a waiting steer is ONE atomic in-place flag flip — the item
 * keeps its FIFO position, id, and timestamp, so the whole queue still drains
 * in the user's instruction order at the seal, and no reclaim window exists.
 */
describe('handleSteerArm (real in-memory job manager)', () => {
  function createCapableJob(streamId: string) {
    return GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { preemptCapable: true },
    });
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsSupported.mockReturnValue(true);
    mockIsPreemptSupported.mockReturnValue(true);
    GenerationJobManager.configure({
      jobStore: new InMemoryJobStore({ ttlAfterComplete: 60000 }),
      eventTransport: new InMemoryEventTransport(),
      isRedis: false,
      cleanupOnComplete: false,
    });
    GenerationJobManager.initialize();
  });

  afterEach(async () => {
    await GenerationJobManager.destroy();
  });

  it('400s on invalid input', async () => {
    expect((await handleSteerArm(user, { steerId: 's1' })).status).toBe(400);
    const badId = await handleSteerArm(user, { conversationId: 'c1', steerId: '' });
    expect(badId.status).toBe(400);
    expect(badId.body.code).toBe('INVALID_STEER_ID');
  });

  it('409s an arm targeting a replaced generation without relabelling the live steer', async () => {
    const streamId = 'arm-stale-client-generation';
    const job = await createCapableJob(streamId);
    const posted = await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'still an ordinary steer',
    });

    const result = await handleSteerArm(user, {
      conversationId: streamId,
      generationCreatedAt: job.createdAt - 1,
      steerId: posted.body.steerId as string,
    });

    expect(result).toEqual({ status: 409, body: { code: 'RUN_REPLACED' } });
    expect((await GenerationJobManager.steering.peek(streamId))[0].preempt).toBeUndefined();
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
  });

  it('arms a queued steer in place: same item, same position, now preempting', async () => {
    const streamId = 'arm-in-place';
    await createCapableJob(streamId);
    const first = await handleSteerRequest(user, { conversationId: streamId, text: 'first' });
    const second = await handleSteerRequest(user, { conversationId: streamId, text: 'second' });
    const firstId = first.body.steerId as string;

    const armed = await handleSteerArm(user, { conversationId: streamId, steerId: firstId });
    expect(armed).toEqual({ status: 200, body: { armed: true, preemptRevision: 1 } });

    /** FIFO preserved: the escalated steer still drains FIRST at the seal. */
    const queue = await GenerationJobManager.steering.peek(streamId);
    expect(queue.map((item) => item.steerId)).toEqual([firstId, second.body.steerId]);
    expect(queue[0].preempt).toBe(true);
    expect(queue[1].preempt).toBeUndefined();
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(true);
  });

  it('is idempotent when a client retries after losing the first response', async () => {
    const streamId = 'arm-idempotent-retry';
    await createCapableJob(streamId);
    const posted = await handleSteerRequest(user, { conversationId: streamId, text: 'once only' });
    const steerId = posted.body.steerId as string;

    await expect(handleSteerArm(user, { conversationId: streamId, steerId })).resolves.toEqual({
      status: 200,
      body: { armed: true, preemptRevision: 1 },
    });
    await expect(handleSteerArm(user, { conversationId: streamId, steerId })).resolves.toEqual({
      status: 200,
      body: { armed: true, preemptRevision: 2 },
    });

    const queue = await GenerationJobManager.steering.peek(streamId);
    expect(queue).toHaveLength(1);
    expect(queue[0]).toMatchObject({ steerId, text: 'once only', preempt: true });
  });

  it('uses the durable arm revision internally when a v1 job regains capability', async () => {
    const streamId = 'arm-v1-revision-after-capability-handover';
    const job = await GenerationJobManager.createJob(streamId, user.id, undefined, {
      initialMetadata: { generationProtocolVersion: 1, preemptCapable: true },
    });
    const posted = await handleSteerRequest(
      user,
      { conversationId: streamId, text: 'interrupt after handover' },
      { generationProtocolVersion: 2 },
    );
    const steerId = posted.body.steerId as string;

    const firstArm = await GenerationJobManager.steering.armVersioned(
      streamId,
      steerId,
      job.createdAt,
    );
    expect(firstArm).toMatchObject({ outcome: 'armed', revision: 1 });
    await GenerationJobManager.requestPreempt(streamId, steerId, job.createdAt, 1);

    await GenerationJobManager.updateMetadata(streamId, { preemptCapable: false });
    await expect(GenerationJobManager.rearmQueuedPreempts(streamId, job.createdAt)).resolves.toBe(
      0,
    );
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
    await GenerationJobManager.updateMetadata(streamId, { preemptCapable: true });

    const rearmed = await handleSteerArm(
      user,
      { conversationId: streamId, generationCreatedAt: job.createdAt, steerId },
      { generationProtocolVersion: 2 },
    );

    expect(rearmed).toEqual({
      status: 200,
      body: { armed: true, generationProtocolVersion: 1 },
    });
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(true);
    await expect(GenerationJobManager.steering.peek(streamId, job.createdAt)).resolves.toEqual([
      expect.objectContaining({ steerId, preempt: true, preemptRevision: 3 }),
    ]);
  });

  it('refuses to relabel when the owner cannot seal', async () => {
    const streamId = 'arm-incapable';
    await GenerationJobManager.createJob(streamId, user.id);
    const posted = await handleSteerRequest(user, { conversationId: streamId, text: 'plain' });
    const steerId = posted.body.steerId as string;

    const result = await handleSteerArm(user, { conversationId: streamId, steerId });
    expect(result).toEqual({ status: 200, body: { armed: false, code: 'PREEMPT_UNSUPPORTED' } });
    expect((await GenerationJobManager.steering.peek(streamId))[0].preempt).toBeUndefined();
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
  });

  it('refuses to arm a queued steer after the run pauses', async () => {
    const streamId = 'arm-paused';
    await createCapableJob(streamId);
    const posted = await handleSteerRequest(user, { conversationId: streamId, text: 'waiting' });
    const payload = buildToolApprovalPayload([
      { name: 'shell', arguments: { command: 'ls' }, tool_call_id: 'call_arm_paused' },
    ]);
    const action = buildPendingAction(payload, {
      streamId,
      conversationId: streamId,
      runId: 'run-arm-paused',
      responseMessageId: 'msg-arm-paused',
    });
    expect(await GenerationJobManager.approvals.pause(streamId, action)).toBe(true);

    const result = await handleSteerArm(user, {
      conversationId: streamId,
      steerId: posted.body.steerId as string,
    });

    expect(result).toEqual({ status: 200, body: { armed: false } });
    expect((await GenerationJobManager.steering.peek(streamId))[0].preempt).toBeUndefined();
    expect(GenerationJobManager.isPreemptRequested(streamId)).toBe(false);
  });

  it('reports armed:false when the steer already left the queue', async () => {
    const streamId = 'arm-too-late';
    await createCapableJob(streamId);
    const posted = await handleSteerRequest(user, { conversationId: streamId, text: 'gone soon' });
    const steerId = posted.body.steerId as string;
    await GenerationJobManager.steering.cancel(streamId, steerId);

    const result = await handleSteerArm(user, { conversationId: streamId, steerId });
    expect(result).toEqual({ status: 200, body: { armed: false } });
  });

  it('treats a missing job as a lost race, not an error', async () => {
    const result = await handleSteerArm(user, { conversationId: 'gone', steerId: 's1' });
    expect(result).toEqual({ status: 200, body: { armed: false } });
  });

  it("403s another user's run", async () => {
    const streamId = 'arm-foreign';
    await GenerationJobManager.createJob(streamId, 'someone-else');
    const result = await handleSteerArm(user, { conversationId: streamId, steerId: 'x' });
    expect(result.status).toBe(403);
  });

  it('fails closed when the stored job owner is missing', async () => {
    const streamId = 'arm-missing-owner';
    await createCapableJob(streamId);
    const posted = await handleSteerRequest(user, {
      conversationId: streamId,
      text: 'do not arm from malformed state',
    });
    await removeStoredJobOwner(streamId);

    const result = await handleSteerArm(user, {
      conversationId: streamId,
      steerId: posted.body.steerId as string,
    });

    expect(result).toEqual({ status: 403, body: { code: 'UNAUTHORIZED' } });
    expect((await GenerationJobManager.steering.peek(streamId))[0].preempt).toBeUndefined();
  });

  it('refuses when capability was rewritten for the same generation mid-flight', async () => {
    /** A HITL resume on a rolling deploy rewrites `preemptCapable` for the
     *  SAME createdAt, so the capability must live inside the atomic store
     *  predicate — a value read before the arm is not trustworthy. */
    const streamId = 'arm-capability-rewritten';
    await createCapableJob(streamId);
    const posted = await handleSteerRequest(user, { conversationId: streamId, text: 'waiting' });
    await GenerationJobManager.updateMetadata(streamId, { preemptCapable: false });

    const result = await handleSteerArm(user, {
      conversationId: streamId,
      steerId: posted.body.steerId as string,
    });
    expect(result).toEqual({ status: 200, body: { armed: false, code: 'PREEMPT_UNSUPPORTED' } });
    expect((await GenerationJobManager.steering.peek(streamId))[0].preempt).toBeUndefined();
  });

  it("never arms another generation's steer", async () => {
    const streamId = 'arm-stale-generation';
    await createCapableJob(streamId);
    const posted = await handleSteerRequest(user, { conversationId: streamId, text: 'target' });
    const live = await GenerationJobManager.getJob(streamId);

    const armed = await GenerationJobManager.steering.arm(
      streamId,
      posted.body.steerId as string,
      (live?.createdAt as number) + 999,
    );
    expect(armed).toBe('missing');
    expect((await GenerationJobManager.steering.peek(streamId))[0].preempt).toBeUndefined();
  });
});
