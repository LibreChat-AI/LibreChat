import express from 'express';
import request from 'supertest';
import { logger } from '@librechat/data-schemas';
import type { NextFunction, Request, Response } from 'express';
import {
  detectGenerationRetry,
  generationRetryLimiter,
  generationRetryProbeLimiter,
  GENERATION_RETRY_MAX,
  GENERATION_RETRY_PROBE_MAX,
  isConfirmedGenerationRetry,
} from './generationRetry';
import { GenerationJobManager } from '~/stream/GenerationJobManager';

function generationRequest(overrides: Partial<Request> = {}): Request {
  return {
    method: 'POST',
    path: '/',
    body: { clientRequestId: 'request-1' },
    user: { id: 'user-1' },
    ...overrides,
  } as Request;
}

describe('generation retry admission', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('marks only a submission with an existing durable claim as a retry', async () => {
    const hasClaim = jest.spyOn(GenerationJobManager, 'hasGenerationClaim').mockResolvedValue(true);
    const req = generationRequest();
    const next = jest.fn() as NextFunction;

    await detectGenerationRetry(req, {} as Response, next);

    expect(hasClaim).toHaveBeenCalledWith('user-1', 'request-1');
    expect(isConfirmedGenerationRetry(req)).toBe(true);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('leaves a new submission subject to the ordinary message limiters', async () => {
    jest.spyOn(GenerationJobManager, 'hasGenerationClaim').mockResolvedValue(false);
    const req = generationRequest();

    await detectGenerationRetry(req, {} as Response, jest.fn());

    expect(isConfirmedGenerationRetry(req)).toBe(false);
  });

  it.each([
    ['a resume', { path: '/resume' }],
    ['a resume with a trailing slash', { path: '/resume/' }],
    ['a case-insensitive resume route', { path: '/Resume' }],
    ['a request without an authenticated user', { user: undefined }],
    ['an invalid idempotency key', { body: { clientRequestId: 'invalid key' } }],
  ])('does not probe %s', async (_label, overrides) => {
    const hasClaim = jest.spyOn(GenerationJobManager, 'hasGenerationClaim');
    const req = generationRequest(overrides as Partial<Request>);
    const next = jest.fn() as NextFunction;

    await detectGenerationRetry(req, {} as Response, next);

    expect(hasClaim).not.toHaveBeenCalled();
    expect(isConfirmedGenerationRetry(req)).toBe(false);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('fails closed to the ordinary limiters when the claim probe is unavailable', async () => {
    jest
      .spyOn(GenerationJobManager, 'hasGenerationClaim')
      .mockRejectedValue(new Error('store unavailable'));
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);
    const req = generationRequest();
    const next = jest.fn() as NextFunction;

    await detectGenerationRetry(req, {} as Response, next);

    expect(isConfirmedGenerationRetry(req)).toBe(false);
    expect(warn).toHaveBeenCalledWith(
      '[GenerationIdempotency] Failed to inspect start-generation claim',
      expect.objectContaining({ userId: 'user-1', clientRequestId: 'request-1' }),
    );
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('bounds fresh claim probes before accessing the shared store', async () => {
    const hasClaim = jest
      .spyOn(GenerationJobManager, 'hasGenerationClaim')
      .mockResolvedValue(false);
    const downstream = jest.fn((_req, res) => res.sendStatus(204));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'bounded-probe-user' };
      next();
    });
    app.use(generationRetryProbeLimiter);
    app.use(detectGenerationRetry);
    app.post('/', downstream);

    for (let attempt = 0; attempt < GENERATION_RETRY_PROBE_MAX; attempt += 1) {
      await request(app)
        .post('/')
        .send({ clientRequestId: `probe-${attempt}` })
        .expect(204);
    }
    const rejected = await request(app)
      .post('/')
      .send({ clientRequestId: 'probe-rejected' })
      .expect(503);

    expect(rejected.headers['retry-after']).toBeDefined();
    expect(rejected.body.code).toBe('SERVER_NOT_READY');
    expect(hasClaim).toHaveBeenCalledTimes(GENERATION_RETRY_PROBE_MAX);
    expect(downstream).toHaveBeenCalledTimes(GENERATION_RETRY_PROBE_MAX);
  });

  it('makes a bounded confirmed retry delay participate in readiness recovery', async () => {
    jest.spyOn(GenerationJobManager, 'hasGenerationClaim').mockResolvedValue(true);
    const downstream = jest.fn((_req, res) => res.sendStatus(204));
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.user = { id: 'bounded-retry-user' };
      next();
    });
    app.use(detectGenerationRetry);
    app.use(generationRetryLimiter);
    app.post('/', downstream);

    for (let attempt = 0; attempt < GENERATION_RETRY_MAX; attempt += 1) {
      await request(app).post('/').send({ clientRequestId: 'bounded-request' }).expect(204);
    }
    const rejected = await request(app)
      .post('/')
      .send({ clientRequestId: 'bounded-request' })
      .expect(503);

    expect(rejected.headers['retry-after']).toBeDefined();
    expect(rejected.body.code).toBe('SERVER_NOT_READY');
    expect(downstream).toHaveBeenCalledTimes(GENERATION_RETRY_MAX);
  });
});
