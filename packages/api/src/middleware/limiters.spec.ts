import express from 'express';
import request from 'supertest';
import rateLimit from 'express-rate-limit';
import type { Request, Response } from 'express';
import { createMediaAdmissionPolicy } from '../media/admission';
import { createMessageLimiters } from './limiters';

describe('shared message admission', () => {
  it('initializes one event bucket after configuration without a request-construction diagnostic', async () => {
    const environment: Record<string, string | undefined> = { MESSAGE_USER_MAX: '1' };
    const logViolation = jest.fn(async () => undefined);
    const diagnostic = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const limits = createMessageLimiters({
        factory: rateLimit,
        createStore: () => undefined,
        environment,
        logViolation,
        denyRequest: async (_req, res) => {
          res.sendStatus(429);
        },
      });
      environment.AGENT_EVENT_USER_MAX = '1';
      environment.AGENT_EVENT_USER_WINDOW = '2';
      const app = express();
      app.use((req, _res, next) => {
        req.user = { id: 'event-owner' } as Express.User;
        next();
      });
      app.post('/chat', limits.messageUserLimiter, (_req, res) => {
        res.sendStatus(200);
      });
      app.post('/events', limits.agentEventUserLimiter, (_req, res) => {
        res.sendStatus(200);
      });
      await request(app).post('/chat').expect(200);
      await request(app).post('/events').expect(200);
      const denied = await request(app).post('/events').expect(429);
      expect(denied.body.error.code).toBe('agent_event_rate_limited');
      expect(Number(denied.headers['retry-after'])).toBeGreaterThan(0);
      expect(logViolation).not.toHaveBeenCalled();
      expect(diagnostic).not.toHaveBeenCalled();
    } finally {
      diagnostic.mockRestore();
    }
  });

  it('charges agent tools to the HTTP buckets after streaming has started without writing response headers', async () => {
    const environment = { MESSAGE_USER_MAX: '2', LIMIT_MESSAGE_USER: 'true' };
    const logViolation = jest.fn(async () => undefined);
    const denyRequest = jest.fn(async () => undefined);
    const limits = createMessageLimiters({
      factory: rateLimit,
      createStore: () => undefined,
      environment,
      logViolation,
      denyRequest,
    });
    const policy = createMediaAdmissionPolicy(
      {
        ...limits,
        logViolation,
        checkBan: (_req, _res, next) => next(),
        createFileLimiters: () => ({
          fileUploadIpLimiter: (_req, _res, next) => next(),
          fileUploadUserLimiter: (_req, _res, next) => next(),
        }),
      },
      environment,
    );
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'tool-owner' } as Express.User;
      next();
    });
    app.post('/chat', limits.messageUserLimiter, (_req, res) => {
      res.sendStatus(200);
    });
    app.post('/tools', async (req, res, next) => {
      try {
        res.type('text/plain').write('streaming:');
        await policy.admitToolGeneration!(req);
        await expect(policy.admitToolGeneration!(req)).rejects.toMatchObject({
          status: 429,
          code: 'quota_exceeded',
        });
        res.end('first accepted; second denied');
      } catch (error) {
        next(error);
      }
    });
    await request(app).post('/chat').expect(200);
    const response = await request(app).post('/tools').expect(200);
    expect(response.text).toBe('streaming:first accepted; second denied');
    expect(logViolation).toHaveBeenCalledTimes(1);
    expect(denyRequest).not.toHaveBeenCalled();
  });

  it('shares one user bucket across chat and JSON surfaces while preserving their error presentation', async () => {
    const denyRequest = jest.fn(async (_req: Request, res: Response) => {
      res.status(429).json({ chat: true });
    });
    const logViolation = jest.fn(async () => undefined);
    const { messageUserLimiter } = createMessageLimiters({
      factory: rateLimit,
      createStore: () => undefined,
      environment: { MESSAGE_USER_MAX: '1', MESSAGE_USER_WINDOW: '1' },
      logViolation,
      denyRequest,
    });
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: 'owner' } as Express.User;
      next();
    });
    app.post('/chat', messageUserLimiter, (_req, res) => {
      res.sendStatus(200);
    });
    app.post(
      '/json',
      (_req, res, next) => {
        res.locals.rateLimitError = () =>
          res.status(429).json({ error: { code: 'quota_exceeded' } });
        next();
      },
      messageUserLimiter,
      (_req, res) => {
        res.sendStatus(200);
      },
    );
    await request(app).post('/chat').expect(200);
    expect((await request(app).post('/json').expect(429)).body).toEqual({
      error: { code: 'quota_exceeded' },
    });
    expect(denyRequest).not.toHaveBeenCalled();
    expect(logViolation).toHaveBeenCalledTimes(1);
    expect((await request(app).post('/chat').expect(429)).body).toEqual({ chat: true });
    expect(denyRequest).toHaveBeenCalledTimes(1);
  });
});
