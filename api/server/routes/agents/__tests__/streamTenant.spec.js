const express = require('express');
const request = require('supertest');

const mockGenerationJobManager = {
  getJob: jest.fn(),
  subscribe: jest.fn(),
  subscribeWithResume: jest.fn(),
  getResumeState: jest.fn(),
  markSyncSent: jest.fn(),
  abortJob: jest.fn(),
  getActiveJobIdsForUser: jest.fn().mockResolvedValue([]),
  steering: {
    claim: jest.fn().mockResolvedValue([]),
    claimDetailed: jest.fn().mockResolvedValue({ generationProtocolVersion: 1, steers: [] }),
  },
};
const mockCaptureAgentCheckpointGeneration = jest.fn();
const mockDeleteAgentCheckpoint = jest.fn();
const mockSaveMessage = jest.fn();

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
  },
}));

jest.mock('@librechat/api', () => ({
  ...jest.requireActual('@librechat/api'),
  isEnabled: jest.fn().mockReturnValue(false),
  GenerationJobManager: mockGenerationJobManager,
  captureAgentCheckpointGeneration: (...args) => mockCaptureAgentCheckpointGeneration(...args),
  deleteAgentCheckpoint: (...args) => mockDeleteAgentCheckpoint(...args),
}));

jest.mock('~/models', () => ({
  saveMessage: (...args) => mockSaveMessage(...args),
}));

let mockUserId = 'user-123';
let mockTenantId;

jest.mock('~/server/middleware', () => ({
  uaParser: (req, res, next) => next(),
  checkBan: (req, res, next) => next(),
  requireJwtAuth: (req, res, next) => {
    req.user = { id: mockUserId, tenantId: mockTenantId };
    next();
  },
  moderateText: (req, res, next) => next(),
  messageIpLimiter: (req, res, next) => next(),
  configMiddleware: (req, res, next) => next(),
  messageUserLimiter: (req, res, next) => next(),
}));

jest.mock('~/server/routes/agents/chat', () => require('express').Router());
jest.mock('~/server/routes/agents/v1', () => {
  const router = require('express').Router();
  router.use((req, res) => res.status(418).json({ error: 'v1 caught stream route' }));
  return { v1: router };
});
jest.mock('~/server/routes/agents/openai', () => require('express').Router());
jest.mock('~/server/routes/agents/responses', () => require('express').Router());
jest.mock('~/server/routes/agents/management', () => require('express').Router());

const agentsRouter = require('../index');
const app = express();
app.use(express.json());
app.use('/agents', agentsRouter);
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));

function mockSubscribeSuccess() {
  mockGenerationJobManager.subscribe.mockImplementation((_streamId, _writeEvent, onDone) => {
    process.nextTick(() => onDone({ done: true }));
    return { unsubscribe: jest.fn() };
  });
}

describe('SSE stream tenant isolation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockUserId = 'user-123';
    mockTenantId = undefined;
    mockCaptureAgentCheckpointGeneration.mockResolvedValue({
      threadId: 'stream-123',
      checkpointIds: ['checkpoint-a'],
    });
    mockDeleteAgentCheckpoint.mockResolvedValue(undefined);
    mockSaveMessage.mockResolvedValue({ persisted: true });
    mockGenerationJobManager.getActiveJobIdsForUser.mockResolvedValue([]);
    mockGenerationJobManager.steering.claim.mockResolvedValue([]);
    mockGenerationJobManager.steering.claimDetailed.mockResolvedValue({
      generationProtocolVersion: 1,
      steers: [],
    });
  });

  describe('GET /chat/stream/:streamId', () => {
    it('returns 403 when a user from a different tenant accesses a stream', async () => {
      mockUserId = 'user-456';
      mockTenantId = 'tenant-b';

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-456', tenantId: 'tenant-a' },
        status: 'running',
      });

      const res = await request(app).get('/agents/chat/stream/stream-123');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns 404 when stream does not exist', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(null);

      const res = await request(app).get('/agents/chat/stream/nonexistent');
      expect(res.status).toBe(404);
    });

    it('returns GENERATION_REPLACED before SSE headers when the requested epoch is stale', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123' },
        status: 'running',
        createdAt: 2000,
      });

      const res = await request(app).get('/agents/chat/stream/stream-123?generationCreatedAt=1000');

      expect(res.status).toBe(409);
      expect(res.body).toEqual(expect.objectContaining({ code: 'GENERATION_REPLACED' }));
      expect(res.headers['content-type']).not.toContain('text/event-stream');
      expect(mockGenerationJobManager.subscribe).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.subscribeWithResume).not.toHaveBeenCalled();
    });

    it('passes the expected epoch into the manager subscription fence', async () => {
      mockSubscribeSuccess();
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123' },
        status: 'running',
        createdAt: 1000,
      });

      const res = await request(app).get('/agents/chat/stream/stream-123?generationCreatedAt=1000');

      expect(res.status).toBe(200);
      expect(mockGenerationJobManager.subscribe).toHaveBeenCalledWith(
        'stream-123',
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({ expectedCreatedAt: 1000 }),
      );
    });

    it('pins an unfenced legacy subscription to the generation that passed authorization', async () => {
      mockSubscribeSuccess();
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
        createdAt: 1000,
      });
      mockTenantId = 'tenant-a';

      const res = await request(app).get('/agents/chat/stream/stream-123');

      expect(res.status).toBe(200);
      expect(mockGenerationJobManager.subscribe).toHaveBeenCalledWith(
        'stream-123',
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({ expectedCreatedAt: 1000 }),
      );
    });

    it('never attaches a cross-owner replacement after authorizing the predecessor', async () => {
      mockGenerationJobManager.getJob
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123', tenantId: 'tenant-a' },
          status: 'running',
          createdAt: 1000,
          conversationId: 'stream-123',
        })
        .mockResolvedValueOnce({
          metadata: { userId: 'other-user', tenantId: 'tenant-b' },
          status: 'running',
          createdAt: 2000,
          conversationId: 'stream-123',
        });
      mockTenantId = 'tenant-a';
      mockGenerationJobManager.subscribe.mockResolvedValue(null);

      const res = await request(app).get('/agents/chat/stream/stream-123');

      expect(res.status).toBe(200);
      expect(mockGenerationJobManager.subscribe).toHaveBeenCalledWith(
        'stream-123',
        expect.any(Function),
        expect.any(Function),
        expect.any(Function),
        expect.objectContaining({ expectedCreatedAt: 1000 }),
      );
      expect(res.text).toContain('event: error');
      expect(res.text).not.toContain('generation_replaced');
    });

    it('fails closed when the job owner is missing', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { tenantId: 'tenant-a' },
        status: 'running',
        createdAt: 1000,
      });
      mockTenantId = 'tenant-a';

      const res = await request(app).get('/agents/chat/stream/stream-123');

      expect(res.status).toBe(403);
      expect(mockGenerationJobManager.subscribe).not.toHaveBeenCalled();
    });

    it('reconciles a replacement that wins after headers but before manager attachment', async () => {
      mockGenerationJobManager.getJob
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123', generationProtocolVersion: 2 },
          status: 'running',
          createdAt: 1000,
          conversationId: 'stream-123',
        })
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123' },
          status: 'running',
          createdAt: 2000,
          conversationId: 'stream-123',
        });
      mockGenerationJobManager.subscribe.mockResolvedValue(null);

      const res = await request(app)
        .get('/agents/chat/stream/stream-123?generationCreatedAt=1000&generationProtocolVersion=2')
        .set('X-LibreChat-Generation-Protocol', '2');
      const payload = JSON.parse(res.text.trim().split('\ndata: ')[1]);

      expect(res.status).toBe(200);
      expect(payload).toEqual({
        final: true,
        reconcile: true,
        reconcileReason: 'generation_replaced',
        generationCreatedAt: 1000,
        conversation: { conversationId: 'stream-123' },
        generationProtocolVersion: 2,
      });
    });

    it('reconciles a generation deleted in the snapshot-to-attach window', async () => {
      mockGenerationJobManager.getJob
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123', generationProtocolVersion: 2 },
          status: 'running',
          createdAt: 1000,
          conversationId: 'stream-123',
        })
        .mockResolvedValueOnce(null);
      mockGenerationJobManager.subscribe.mockResolvedValue(null);

      const res = await request(app)
        .get('/agents/chat/stream/stream-123?generationCreatedAt=1000&generationProtocolVersion=2')
        .set('X-LibreChat-Generation-Protocol', '2');
      const payload = JSON.parse(res.text.trim().split('\ndata: ')[1]);

      expect(res.status).toBe(200);
      expect(payload).toEqual({
        final: true,
        reconcile: true,
        reconcileReason: 'terminal_payload_missing',
        generationCreatedAt: 1000,
        conversation: { conversationId: 'stream-123' },
        generationProtocolVersion: 2,
      });
    });

    it('translates reconciliation into an error for a v1 subscriber', async () => {
      mockGenerationJobManager.getJob
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123', generationProtocolVersion: 1 },
          status: 'running',
          createdAt: 1000,
          conversationId: 'stream-123',
        })
        .mockResolvedValueOnce(null);
      mockGenerationJobManager.subscribe.mockResolvedValue(null);

      const res = await request(app).get('/agents/chat/stream/stream-123?generationCreatedAt=1000');

      expect(res.status).toBe(200);
      expect(res.headers['x-librechat-generation-protocol']).toBe('1');
      expect(res.text).toContain('event: error');
      expect(res.text).toContain('Generation state changed');
      expect(res.text).not.toContain('"reconcile":true');
    });

    it('does not misclassify a failed reconciliation read as a missing terminal job', async () => {
      mockGenerationJobManager.getJob
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123' },
          status: 'running',
          createdAt: 1000,
          conversationId: 'stream-123',
        })
        .mockRejectedValueOnce(new Error('store unavailable'));
      mockGenerationJobManager.subscribe.mockResolvedValue(null);

      const res = await request(app).get('/agents/chat/stream/stream-123?generationCreatedAt=1000');

      expect(res.status).toBe(200);
      expect(res.text).toContain('event: error');
      expect(res.text).toContain('Failed to subscribe to stream');
      expect(res.text).not.toContain('terminal_payload_missing');
    });

    it('proceeds past tenant guard when tenant matches', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';
      mockSubscribeSuccess();

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
        createdAt: 1000,
      });

      const res = await request(app).get('/agents/chat/stream/stream-123');
      expect(res.status).toBe(200);
      expect(mockGenerationJobManager.subscribe).toHaveBeenCalledTimes(1);
    });

    it('proceeds past tenant guard when job has no tenantId (single-tenant mode)', async () => {
      mockUserId = 'user-123';
      mockTenantId = undefined;
      mockSubscribeSuccess();

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123' },
        status: 'running',
        createdAt: 1000,
      });

      const res = await request(app).get('/agents/chat/stream/stream-123');
      expect(res.status).toBe(200);
      expect(mockGenerationJobManager.subscribe).toHaveBeenCalledTimes(1);
    });

    it('writes the resume sync frame before activating live delivery', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123' },
        status: 'running',
        createdAt: 1000,
      });
      const activate = jest.fn();
      mockGenerationJobManager.subscribeWithResume.mockImplementation(
        async (_streamId, writeEvent, onDone) => {
          activate.mockImplementation(() => {
            writeEvent({ event: 'on_message_delta', data: { text: 'live' } });
            onDone({ final: true });
          });
          return {
            subscription: { unsubscribe: jest.fn(), activate },
            resumeState: { runSteps: [], aggregatedContent: [] },
            pendingEvents: [],
          };
        },
      );

      const res = await request(app).get('/agents/chat/stream/stream-123?resume=true');
      const payloads = res.text
        .trim()
        .split('\n\n')
        .map((frame) => JSON.parse(frame.split('\ndata: ')[1]));

      expect(res.status).toBe(200);
      expect(payloads).toEqual([
        {
          sync: true,
          resumeState: { runSteps: [], aggregatedContent: [] },
          pendingEvents: [],
        },
        { event: 'on_message_delta', data: { text: 'live' } },
        { final: true, generationProtocolVersion: 1 },
      ]);
      expect(activate).toHaveBeenCalledTimes(1);
      expect(mockGenerationJobManager.markSyncSent).toHaveBeenCalledWith('stream-123', 1000);
    });

    it('detaches a paused resume subscription when the response ends before activation', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123' },
        status: 'running',
        createdAt: 1000,
      });
      const subscription = {
        unsubscribe: jest.fn(),
        activate: jest.fn(),
      };
      mockGenerationJobManager.subscribeWithResume.mockImplementation(
        async (_streamId, _writeEvent, onDone) => {
          onDone({ final: true });
          return {
            subscription,
            resumeState: { runSteps: [], aggregatedContent: [] },
            pendingEvents: [],
          };
        },
      );

      const res = await request(app).get('/agents/chat/stream/stream-123?resume=true');

      expect(res.status).toBe(200);
      expect(subscription.unsubscribe).toHaveBeenCalled();
      expect(subscription.activate).not.toHaveBeenCalled();
    });

    it('returns 403 when job has tenantId but user has no tenantId', async () => {
      mockUserId = 'user-123';
      mockTenantId = undefined;

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'some-tenant' },
        status: 'running',
      });

      const res = await request(app).get('/agents/chat/stream/stream-123');
      expect(res.status).toBe(403);
    });
  });

  describe('GET /chat/status/:conversationId', () => {
    it('echoes v2 for a clean jobless status after the server rollout gate', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(null);
      mockGenerationJobManager.steering.claimDetailed.mockResolvedValue({
        generationProtocolVersion: 2,
        steers: [],
      });

      const res = await request(app)
        .get('/agents/chat/status/conv-123?generationProtocolVersion=2')
        .set('X-LibreChat-Generation-Protocol', '2');

      expect(res.status).toBe(200);
      expect(res.headers['x-librechat-generation-protocol']).toBe('2');
      expect(res.body).toEqual({ active: false, generationProtocolVersion: 2 });
      expect(mockGenerationJobManager.steering.claimDetailed).toHaveBeenCalledWith(
        'conv-123',
        { userId: 'user-123', tenantId: undefined },
        2,
      );
    });

    it('downgrades a jobless v2 request when its parked payload is legacy', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(null);
      mockGenerationJobManager.steering.claimDetailed.mockResolvedValue({
        generationProtocolVersion: 1,
        steers: [{ steerId: 'legacy-steer', text: 'legacy words' }],
      });

      const res = await request(app)
        .get('/agents/chat/status/conv-123?generationProtocolVersion=2')
        .set('X-LibreChat-Generation-Protocol', '2');

      expect(res.status).toBe(200);
      expect(res.headers['x-librechat-generation-protocol']).toBe('1');
      expect(res.body).toEqual({
        active: false,
        generationProtocolVersion: 1,
        unrecoveredSteers: [{ steerId: 'legacy-steer', text: 'legacy words' }],
      });
    });

    it('returns 403 when tenant does not match', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-b';

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
      });

      const res = await request(app).get('/agents/chat/status/conv-123');
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('returns status when tenant matches', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
        createdAt: Date.now(),
      });
      mockGenerationJobManager.getResumeState.mockResolvedValue(null);

      const res = await request(app).get('/agents/chat/status/conv-123');
      expect(res.status).toBe(200);
      expect(res.body.active).toBe(true);
    });

    it('preserves the immutable v2 marker on an active status response', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', generationProtocolVersion: 2 },
        status: 'running',
        createdAt: 1000,
      });
      mockGenerationJobManager.getResumeState.mockResolvedValue(null);

      const res = await request(app)
        .get('/agents/chat/status/conv-123?generationProtocolVersion=2')
        .set('X-LibreChat-Generation-Protocol', '2');

      expect(res.status).toBe(200);
      expect(res.headers['x-librechat-generation-protocol']).toBe('2');
      expect(res.body).toEqual(
        expect.objectContaining({
          active: true,
          streamId: 'conv-123',
          generationProtocolVersion: 2,
        }),
      );
    });

    it('discards resume content when a cross-owner replacement wins after authorization', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';
      mockGenerationJobManager.getJob
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123', tenantId: 'tenant-a' },
          status: 'running',
          createdAt: 1000,
        })
        .mockResolvedValueOnce({
          metadata: { userId: 'other-user', tenantId: 'tenant-b' },
          status: 'running',
          createdAt: 2000,
        });
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [{ text: 'replacement secret' }],
      });

      const res = await request(app).get('/agents/chat/status/conv-123');

      expect(res.status).toBe(403);
      expect(res.text).not.toContain('replacement secret');
    });

    it('retries a same-owner replacement snapshot and returns only its verified state', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-a';
      const first = {
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
        createdAt: 1000,
      };
      const replacement = {
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
        createdAt: 2000,
      };
      mockGenerationJobManager.getJob
        .mockResolvedValueOnce(first)
        .mockResolvedValueOnce(replacement)
        .mockResolvedValueOnce(replacement);
      mockGenerationJobManager.getResumeState
        .mockResolvedValueOnce({ aggregatedContent: [{ text: 'discarded mixed snapshot' }] })
        .mockResolvedValueOnce({ aggregatedContent: [{ text: 'verified replacement' }] });

      const res = await request(app).get('/agents/chat/status/conv-123');

      expect(res.status).toBe(200);
      expect(res.body.createdAt).toBe(2000);
      expect(res.body.aggregatedContent).toEqual([{ text: 'verified replacement' }]);
      expect(res.text).not.toContain('discarded mixed snapshot');
      expect(mockGenerationJobManager.getResumeState).toHaveBeenCalledTimes(2);
    });

    it('fails closed when status snapshots keep changing', async () => {
      mockUserId = 'user-123';
      mockGenerationJobManager.getJob
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123' },
          status: 'running',
          createdAt: 1,
        })
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123' },
          status: 'running',
          createdAt: 2,
        })
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123' },
          status: 'running',
          createdAt: 3,
        })
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123' },
          status: 'running',
          createdAt: 4,
        });
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [{ text: 'never verified' }],
      });

      const res = await request(app).get('/agents/chat/status/conv-123');

      expect(res.status).toBe(503);
      expect(res.body).toEqual({ code: 'SERVER_NOT_READY', generationProtocolVersion: 1 });
      expect(res.text).not.toContain('never verified');
    });

    it('keeps an abort persistence-pending terminal snapshot on the readiness path', async () => {
      const pendingAbort = {
        metadata: {
          userId: 'user-123',
          terminalPersistencePending: true,
        },
        status: 'aborted',
        createdAt: 1000,
      };
      mockGenerationJobManager.getJob.mockResolvedValue(pendingAbort);
      mockGenerationJobManager.getResumeState.mockResolvedValue({
        aggregatedContent: [{ text: 'not authoritative yet' }],
      });

      const res = await request(app).get('/agents/chat/status/conv-123');

      expect(res.status).toBe(503);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body).toEqual({ code: 'SERVER_NOT_READY', generationProtocolVersion: 1 });
      expect(res.text).not.toContain('not authoritative yet');
      expect(mockGenerationJobManager.steering.claim).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.steering.claimDetailed).not.toHaveBeenCalled();
    });

    it('fails closed when the status job owner is missing', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: {},
        status: 'running',
        createdAt: 1000,
      });

      const res = await request(app).get('/agents/chat/status/conv-123');

      expect(res.status).toBe(403);
      expect(mockGenerationJobManager.getResumeState).not.toHaveBeenCalled();
    });
  });

  describe('POST /chat/abort', () => {
    it.each([
      [{ streamId: { malicious: true } }],
      [{ conversationId: 123 }],
      [{ abortKey: { split: 'not a function' } }],
      [{ streamId: '' }],
    ])('rejects malformed abort target fields without touching the store', async (body) => {
      const res = await request(app).post('/agents/chat/abort').send(body);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({ code: 'INVALID_ABORT_TARGET', generationProtocolVersion: 1 });
      expect(mockGenerationJobManager.getJob).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
    });

    it('returns 403 when tenant does not match', async () => {
      mockUserId = 'user-123';
      mockTenantId = 'tenant-b';

      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', tenantId: 'tenant-a' },
        status: 'running',
      });

      const res = await request(app).post('/agents/chat/abort').send({ streamId: 'stream-123' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Unauthorized');
    });

    it('fails closed when the stored job owner is missing', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: {},
        status: 'running',
        createdAt: 1000,
      });

      const res = await request(app).post('/agents/chat/abort').send({
        streamId: 'stream-123',
        generationCreatedAt: 1000,
      });

      expect(res.status).toBe(403);
      expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
    });

    it('does not fall back from an unknown concrete id to an unrelated active run', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue(null);
      mockGenerationJobManager.getActiveJobIdsForUser.mockResolvedValue(['other-active']);

      const res = await request(app).post('/agents/chat/abort').send({
        streamId: 'stale-or-typo-id',
      });

      expect(res.status).toBe(404);
      expect(mockGenerationJobManager.getActiveJobIdsForUser).not.toHaveBeenCalled();
      expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
    });

    it('uses the generation epoch to resolve the exact new-placeholder run', async () => {
      mockGenerationJobManager.getActiveJobIdsForUser.mockResolvedValue(['run-a', 'run-b']);
      mockGenerationJobManager.getJob.mockImplementation(async (streamId) => ({
        metadata: { userId: 'user-123' },
        status: 'running',
        createdAt: streamId === 'run-a' ? 1000 : 2000,
      }));
      mockGenerationJobManager.abortJob.mockResolvedValue({ success: true });

      const res = await request(app).post('/agents/chat/abort').send({
        conversationId: 'new',
        generationCreatedAt: 2000,
      });

      expect(res.status).toBe(200);
      expect(res.body.aborted).toBe('run-b');
      expect(mockGenerationJobManager.abortJob).toHaveBeenCalledWith(
        'run-b',
        expect.objectContaining({ expectedCreatedAt: 2000 }),
      );
    });

    it('refuses an ambiguous unfenced new-placeholder abort', async () => {
      mockGenerationJobManager.getActiveJobIdsForUser.mockResolvedValue(['run-a', 'run-b']);
      mockGenerationJobManager.getJob.mockImplementation(async (streamId) => ({
        metadata: { userId: 'user-123' },
        status: 'running',
        createdAt: streamId === 'run-a' ? 1000 : 2000,
      }));

      const res = await request(app).post('/agents/chat/abort').send({ conversationId: 'new' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({
        code: 'AMBIGUOUS_ACTIVE_RUN',
        generationProtocolVersion: 1,
      });
      expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
    });

    it('409s a stale generation identity without aborting the replacement', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123' },
        status: 'running',
        createdAt: 2000,
      });

      const res = await request(app).post('/agents/chat/abort').send({
        streamId: 'stream-123',
        generationCreatedAt: 1000,
      });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ code: 'RUN_REPLACED', generationProtocolVersion: 1 });
      expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
    });

    it('threads the authenticated epoch into abortJob and reports a manager-side replacement', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123' },
        status: 'running',
        createdAt: 1000,
      });
      mockGenerationJobManager.abortJob.mockResolvedValue({
        success: false,
        failureReason: 'generation_replaced',
      });

      const res = await request(app).post('/agents/chat/abort').send({
        streamId: 'stream-123',
        generationCreatedAt: 1000,
      });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ code: 'RUN_REPLACED', generationProtocolVersion: 1 });
      expect(mockGenerationJobManager.abortJob).toHaveBeenCalledWith(
        'stream-123',
        expect.objectContaining({ expectedCreatedAt: 1000 }),
      );
    });

    it('does not report success when the same generation remains active after an abort race', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123' },
        status: 'running',
        createdAt: 1000,
      });
      mockGenerationJobManager.abortJob.mockResolvedValue({
        success: false,
        failureReason: 'job_still_active',
      });

      const res = await request(app).post('/agents/chat/abort').send({
        streamId: 'stream-123',
        generationCreatedAt: 1000,
      });

      expect(res.status).toBe(409);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body).toEqual({ code: 'RUN_STILL_ACTIVE', generationProtocolVersion: 1 });
    });

    it('reports an already-settled generation when natural completion wins the abort CAS', async () => {
      mockGenerationJobManager.getJob
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123', generationProtocolVersion: 2 },
          status: 'running',
          createdAt: 1000,
        })
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123', generationProtocolVersion: 2 },
          status: 'complete',
          createdAt: 1000,
        });
      mockGenerationJobManager.abortJob.mockResolvedValue({
        success: false,
        jobData: { status: 'running', createdAt: 1000 },
      });

      const res = await request(app)
        .post('/agents/chat/abort')
        .set('X-LibreChat-Generation-Protocol', '2')
        .send({
          streamId: 'stream-123',
          generationCreatedAt: 1000,
          generationProtocolVersion: 2,
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: false,
        settled: true,
        code: 'RUN_ALREADY_SETTLED',
        streamId: 'stream-123',
        terminalStatus: 'complete',
        generationProtocolVersion: 2,
      });
    });

    it('keeps the legacy abort ACK shape when natural completion wins for protocol v1', async () => {
      mockGenerationJobManager.getJob
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123', generationProtocolVersion: 1 },
          status: 'running',
          createdAt: 1000,
        })
        .mockResolvedValueOnce({
          metadata: { userId: 'user-123', generationProtocolVersion: 1 },
          status: 'complete',
          createdAt: 1000,
        });
      mockGenerationJobManager.abortJob.mockResolvedValue({
        success: false,
        jobData: { status: 'running', createdAt: 1000 },
      });

      const res = await request(app).post('/agents/chat/abort').send({
        streamId: 'stream-123',
        generationCreatedAt: 1000,
      });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        aborted: 'stream-123',
        generationProtocolVersion: 1,
      });
    });

    it('returns 404 when the job disappears before the manager can observe it', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123' },
        status: 'running',
        createdAt: 1000,
      });
      mockGenerationJobManager.abortJob.mockResolvedValue({
        success: false,
        jobData: null,
      });

      const res = await request(app).post('/agents/chat/abort').send({
        streamId: 'stream-123',
        generationCreatedAt: 1000,
      });

      expect(res.status).toBe(404);
      expect(res.body).toEqual({
        success: false,
        error: 'Job not found',
        streamId: 'stream-123',
        generationProtocolVersion: 1,
      });
    });

    it('leaves the run untouched when the required checkpoint snapshot cannot be captured', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: {
          userId: 'user-123',
          pendingAction: { payload: { type: 'tool_approval' } },
        },
        status: 'requires_action',
        createdAt: 1000,
      });
      mockCaptureAgentCheckpointGeneration.mockRejectedValue(
        new Error('checkpoint snapshot unavailable'),
      );

      const res = await request(app).post('/agents/chat/abort').send({
        streamId: 'stream-123',
        generationCreatedAt: 1000,
      });

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        code: 'ABORT_FAILED',
        error: 'Failed to abort generation',
        generationProtocolVersion: 1,
      });
      expect(mockCaptureAgentCheckpointGeneration).toHaveBeenCalledWith('stream-123', undefined, {
        throwOnError: true,
      });
      expect(mockGenerationJobManager.abortJob).not.toHaveBeenCalled();
    });

    it('persists the aborted parent and prunes the captured checkpoint before normal FINAL', async () => {
      const publishFinal = jest.fn();
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: {
          userId: 'user-123',
          pendingAction: { payload: { type: 'tool_approval' } },
        },
        status: 'requires_action',
        createdAt: 1000,
      });
      mockGenerationJobManager.abortJob.mockImplementation(async (_streamId, options) => {
        const abortResult = {
          success: true,
          jobData: {
            createdAt: 1000,
            conversationId: 'stream-123',
            responseMessageId: 'response-1',
            userMessage: { messageId: 'user-1' },
            sender: 'Agent',
            endpoint: 'agents',
          },
          content: [{ type: 'text', text: 'partial answer' }],
          text: 'partial answer',
          pendingSteers: [{ steerId: 'steer-1', text: 'next' }],
        };
        await options.beforePublish(abortResult);
        publishFinal();
        return abortResult;
      });

      const res = await request(app).post('/agents/chat/abort').send({
        streamId: 'stream-123',
        generationCreatedAt: 1000,
      });

      expect(res.status).toBe(200);
      expect(mockCaptureAgentCheckpointGeneration).toHaveBeenCalledWith('stream-123', undefined, {
        throwOnError: true,
      });
      expect(mockSaveMessage).toHaveBeenCalledTimes(2);
      expect(mockSaveMessage).toHaveBeenNthCalledWith(
        1,
        expect.any(Object),
        expect.objectContaining({ messageId: 'user-1', isCreatedByUser: true }),
        expect.any(Object),
      );
      expect(mockSaveMessage).toHaveBeenNthCalledWith(
        2,
        expect.any(Object),
        expect.objectContaining({ messageId: 'response-1', isCreatedByUser: false }),
        expect.any(Object),
      );
      expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
        'stream-123',
        undefined,
        { threadId: 'stream-123', checkpointIds: ['checkpoint-a'] },
        { throwOnError: true },
      );
      expect(mockSaveMessage.mock.invocationCallOrder[0]).toBeLessThan(
        publishFinal.mock.invocationCallOrder[0],
      );
      expect(mockDeleteAgentCheckpoint.mock.invocationCallOrder[0]).toBeLessThan(
        publishFinal.mock.invocationCallOrder[0],
      );
      expect(mockSaveMessage.mock.invocationCallOrder[1]).toBeLessThan(
        mockDeleteAgentCheckpoint.mock.invocationCallOrder[0],
      );
      expect(mockSaveMessage.mock.invocationCallOrder[0]).toBeLessThan(
        mockSaveMessage.mock.invocationCallOrder[1],
      );
      expect(res.body.pendingSteers).toEqual([{ steerId: 'steer-1', text: 'next' }]);
    });

    it('prunes the whole immutable generation namespace without a racy id snapshot', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: {
          userId: 'user-123',
          checkpointNamespace: 'generation-1000',
          pendingAction: { payload: { type: 'tool_approval' } },
        },
        status: 'requires_action',
        createdAt: 1000,
      });
      mockGenerationJobManager.abortJob.mockImplementation(async (_streamId, options) => {
        const abortResult = {
          success: true,
          jobData: { createdAt: 1000, conversationId: 'stream-123' },
          content: [],
          text: '',
          pendingSteers: [],
        };
        await options.beforePublish(abortResult);
        return abortResult;
      });

      const res = await request(app).post('/agents/chat/abort').send({
        streamId: 'stream-123',
        generationCreatedAt: 1000,
      });

      expect(res.status).toBe(200);
      expect(mockCaptureAgentCheckpointGeneration).not.toHaveBeenCalled();
      expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith('stream-123', undefined, undefined, {
        throwOnError: true,
        checkpointNamespace: 'generation-1000',
      });
    });

    it('suppresses interrupt-drain payloads when required abort persistence fails', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', generationProtocolVersion: 2 },
        status: 'running',
        createdAt: 1000,
      });
      mockGenerationJobManager.abortJob.mockResolvedValue({
        success: true,
        persistenceFailed: true,
        pendingSteers: [{ steerId: 'steer-1', text: 'do not auto-send' }],
      });

      const res = await request(app)
        .post('/agents/chat/abort')
        .set('X-LibreChat-Generation-Protocol', '2')
        .send({
          streamId: 'stream-123',
          generationCreatedAt: 1000,
          generationProtocolVersion: 2,
        });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        success: true,
        aborted: 'stream-123',
        persistenceFailed: true,
        generationProtocolVersion: 2,
      });
    });

    it('fails closed instead of acknowledging abort persistence failure to a v1 client', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: { userId: 'user-123', generationProtocolVersion: 1 },
        status: 'running',
        createdAt: 1000,
      });
      mockGenerationJobManager.abortJob.mockResolvedValue({
        success: true,
        persistenceFailed: true,
        pendingSteers: [{ steerId: 'steer-1', text: 'do not expose' }],
      });

      const res = await request(app).post('/agents/chat/abort').send({
        streamId: 'stream-123',
        generationCreatedAt: 1000,
      });

      expect(res.status).toBe(409);
      expect(res.headers['retry-after']).toBe('1');
      expect(res.body).toEqual({
        code: 'ABORT_PERSISTENCE_FAILED',
        generationProtocolVersion: 1,
      });
      expect(res.text).not.toContain('steer-1');
    });

    it('still prunes the captured checkpoint when the aborted-message save fails', async () => {
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: {
          userId: 'user-123',
          generationProtocolVersion: 2,
          pendingAction: { payload: { type: 'tool_approval' } },
        },
        status: 'requires_action',
        createdAt: 1000,
      });
      mockSaveMessage
        .mockResolvedValueOnce({ messageId: 'user-1' })
        .mockRejectedValueOnce(new Error('message store unavailable'));
      mockGenerationJobManager.abortJob.mockImplementation(async (_streamId, options) => {
        const abortResult = {
          success: true,
          jobData: {
            createdAt: 1000,
            conversationId: 'stream-123',
            responseMessageId: 'response-1',
            userMessage: { messageId: 'user-1' },
          },
          content: [{ type: 'text', text: 'partial answer' }],
          text: 'partial answer',
          pendingSteers: [{ steerId: 'steer-1', text: 'do not drain' }],
        };
        try {
          await options.beforePublish(abortResult);
          return abortResult;
        } catch (_error) {
          return { ...abortResult, persistenceFailed: true };
        }
      });

      const res = await request(app)
        .post('/agents/chat/abort')
        .set('X-LibreChat-Generation-Protocol', '2')
        .send({
          streamId: 'stream-123',
          generationCreatedAt: 1000,
          generationProtocolVersion: 2,
        });

      expect(res.status).toBe(200);
      expect(mockSaveMessage).toHaveBeenCalledTimes(2);
      expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
        'stream-123',
        undefined,
        { threadId: 'stream-123', checkpointIds: ['checkpoint-a'] },
        { throwOnError: true },
      );
      expect(res.body).toEqual({
        success: true,
        aborted: 'stream-123',
        persistenceFailed: true,
        generationProtocolVersion: 2,
      });
    });

    it('keeps checkpoint-prune failure on the conservative reconciliation path', async () => {
      const publishNormalFinal = jest.fn();
      const publishReconcile = jest.fn();
      mockGenerationJobManager.getJob.mockResolvedValue({
        metadata: {
          userId: 'user-123',
          generationProtocolVersion: 2,
          pendingAction: { payload: { type: 'tool_approval' } },
        },
        status: 'requires_action',
        createdAt: 1000,
      });
      mockDeleteAgentCheckpoint.mockRejectedValue(new Error('checkpoint store unavailable'));
      mockGenerationJobManager.abortJob.mockImplementation(async (_streamId, options) => {
        const abortResult = {
          success: true,
          jobData: {
            createdAt: 1000,
            conversationId: 'stream-123',
            userMessage: { messageId: 'user-1' },
          },
          content: [],
          text: '',
          pendingSteers: [{ steerId: 'steer-1', text: 'do not drain' }],
        };
        try {
          await options.beforePublish(abortResult);
          publishNormalFinal();
          return abortResult;
        } catch (_error) {
          publishReconcile();
          return { ...abortResult, persistenceFailed: true };
        }
      });

      const res = await request(app)
        .post('/agents/chat/abort')
        .set('X-LibreChat-Generation-Protocol', '2')
        .send({
          streamId: 'stream-123',
          generationCreatedAt: 1000,
          generationProtocolVersion: 2,
        });

      expect(res.status).toBe(200);
      expect(publishNormalFinal).not.toHaveBeenCalled();
      expect(publishReconcile).toHaveBeenCalledTimes(1);
      expect(mockDeleteAgentCheckpoint).toHaveBeenCalledWith(
        'stream-123',
        undefined,
        { threadId: 'stream-123', checkpointIds: ['checkpoint-a'] },
        { throwOnError: true },
      );
      expect(res.body).toEqual({
        success: true,
        aborted: 'stream-123',
        persistenceFailed: true,
        generationProtocolVersion: 2,
      });
    });
  });
});
