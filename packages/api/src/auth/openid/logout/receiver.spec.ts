import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  createOpenIDAuthorizationMethods,
  resolveAuthorizationQueryOptions,
} from '@librechat/data-schemas';
import type { OpenIDAuthorizationMethods } from '@librechat/data-schemas';
import type { Request, Response } from 'express';
import type { Connection } from 'mongoose';
import type {
  BackchannelLogoutToken,
  BackchannelLogoutTokenResult,
  BackchannelLogoutVerifier,
} from './token';
import type { BackchannelLogoutReceiverMethods } from './receiver';
import { createBackchannelLogoutReceiver } from './receiver';

const ISSUER = 'https://issuer.example';
const CLIENT_ID = 'client-1';
const SUBJECT = 'subject-1';

let mongoServer: MongoMemoryServer;
let connection: Connection;
let methods: OpenIDAuthorizationMethods;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  connection = await mongoose.createConnection(mongoServer.getUri()).asPromise();
}, 30_000);

afterAll(async () => {
  await connection.close();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await connection.dropDatabase();
  methods = createOpenIDAuthorizationMethods(
    connection,
    resolveAuthorizationQueryOptions('standalone', { maxTimeMS: 2000 }),
  );
});

function createResponse(): Response {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.end = jest.fn().mockReturnValue(res);
  return res;
}

function createRequest(body: unknown): Request {
  return { body } as Request;
}

function tokenResult(
  overrides: Partial<BackchannelLogoutToken> = {},
): BackchannelLogoutTokenResult {
  return {
    ok: true,
    token: {
      issuer: ISSUER,
      clientId: CLIENT_ID,
      subject: SUBJECT,
      sid: 'sid-1',
      jti: 'jti-1',
      iat: 1_000,
      ...overrides,
    },
  };
}

function createLogger() {
  return { error: jest.fn(), warn: jest.fn() };
}

describe('createBackchannelLogoutReceiver', () => {
  it('returns 404 when disabled', async () => {
    const verifier: BackchannelLogoutVerifier = jest.fn();
    const handler = createBackchannelLogoutReceiver({
      methods,
      verifier,
      config: { enabled: false },
      logger: createLogger(),
    });
    const res = createResponse();
    await handler(createRequest({ logout_token: 'x' }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(verifier).not.toHaveBeenCalled();
  });

  it('returns 400 for a body with no logout_token', async () => {
    const verifier: BackchannelLogoutVerifier = jest.fn();
    const handler = createBackchannelLogoutReceiver({
      methods,
      verifier,
      config: { enabled: true },
      logger: createLogger(),
    });
    const res = createResponse();
    await handler(createRequest({}), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(verifier).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-object body', async () => {
    const verifier: BackchannelLogoutVerifier = jest.fn();
    const handler = createBackchannelLogoutReceiver({
      methods,
      verifier,
      config: { enabled: true },
      logger: createLogger(),
    });
    const res = createResponse();
    await handler(createRequest('not-an-object'), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 for a token the verifier rejects', async () => {
    const verifier: BackchannelLogoutVerifier = jest
      .fn()
      .mockResolvedValue({ ok: false, code: 'invalid_signature' });
    const logger = createLogger();
    const handler = createBackchannelLogoutReceiver({
      methods,
      verifier,
      config: { enabled: true },
      logger,
    });
    const res = createResponse();
    await handler(createRequest({ logout_token: 'bad' }), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('Rejected a logout token'), {
      code: 'invalid_signature',
    });
  });

  it('records the event, enforces it, and returns 200 for a fresh delivery', async () => {
    const verifier: BackchannelLogoutVerifier = jest.fn().mockResolvedValue(tokenResult());
    const handler = createBackchannelLogoutReceiver({
      methods,
      verifier,
      config: { enabled: true },
      logger: createLogger(),
      clock: () => new Date('2024-01-01T00:00:00Z'),
    });
    const res = createResponse();
    await handler(createRequest({ logout_token: 'good' }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const event = await methods.findOpenIDLogoutEvent({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jti: 'jti-1',
    });
    expect(event?.state).toBe('enforced');
    const subject = await methods.findOpenIDSubject({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      subject: SUBJECT,
    });
    expect(subject?.boundaryIat).toBe(1_000);
    const session = await methods.findOpenIDSession({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      sid: 'sid-1',
    });
    expect(session?.revokedAt?.toISOString()).toBe('2024-01-01T00:00:00.000Z');
  });

  it('passes the configured retention through to the enforced event as expiresAt', async () => {
    const verifier: BackchannelLogoutVerifier = jest.fn().mockResolvedValue(tokenResult());
    const handler = createBackchannelLogoutReceiver({
      methods,
      verifier,
      config: { enabled: true, logoutEventRetentionMs: 60_000 },
      logger: createLogger(),
      clock: () => new Date('2024-01-01T00:00:00Z'),
    });
    const res = createResponse();
    await handler(createRequest({ logout_token: 'good' }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const event = await methods.findOpenIDLogoutEvent({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jti: 'jti-1',
    });
    expect(event?.expiresAt?.toISOString()).toBe('2024-01-01T00:01:00.000Z');
  });

  it('skips step 2 but still answers 200 for a duplicate of an already-enforced event', async () => {
    const verifier: BackchannelLogoutVerifier = jest.fn().mockResolvedValue(tokenResult());
    const handler = createBackchannelLogoutReceiver({
      methods,
      verifier,
      config: { enabled: true },
      logger: createLogger(),
    });

    await handler(createRequest({ logout_token: 'good' }), createResponse(), jest.fn());
    const upsertSpy = jest.spyOn(methods, 'upsertOpenIDSubjectBoundary');
    const res = createResponse();
    await handler(createRequest({ logout_token: 'good' }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    expect(upsertSpy).not.toHaveBeenCalled();
  });

  it('resumes step 2 on a duplicate delivery when the first delivery left the event in received', async () => {
    await methods.recordOpenIDLogoutEvent({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      subject: SUBJECT,
      sid: 'sid-1',
      boundaryIat: 1_000,
      jti: 'jti-1',
      receivedAt: new Date(),
    });
    const verifier: BackchannelLogoutVerifier = jest.fn().mockResolvedValue(tokenResult());
    const handler = createBackchannelLogoutReceiver({
      methods,
      verifier,
      config: { enabled: true },
      logger: createLogger(),
    });
    const res = createResponse();
    await handler(createRequest({ logout_token: 'good' }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const event = await methods.findOpenIDLogoutEvent({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      jti: 'jti-1',
    });
    expect(event?.state).toBe('enforced');
    const subject = await methods.findOpenIDSubject({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      subject: SUBJECT,
    });
    expect(subject?.boundaryIat).toBe(1_000);
  });

  it('enforces the stored event on a duplicate delivery even when the retried token carries a different iat', async () => {
    await methods.recordOpenIDLogoutEvent({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      subject: SUBJECT,
      sid: 'sid-1',
      boundaryIat: 1_000,
      jti: 'jti-1',
      receivedAt: new Date(),
    });
    // The retried delivery's own token claims a different iat; the stored event's
    // boundaryIat must still be the one enforced, not this divergent value.
    const verifier: BackchannelLogoutVerifier = jest
      .fn()
      .mockResolvedValue(tokenResult({ iat: 9_999 }));
    const handler = createBackchannelLogoutReceiver({
      methods,
      verifier,
      config: { enabled: true },
      logger: createLogger(),
    });
    const res = createResponse();
    await handler(createRequest({ logout_token: 'good' }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(200);
    const subject = await methods.findOpenIDSubject({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      subject: SUBJECT,
    });
    expect(subject?.boundaryIat).toBe(1_000);
  });

  it('returns 500 and logs an alert with no token content when a write fails', async () => {
    const verifier: BackchannelLogoutVerifier = jest.fn().mockResolvedValue(tokenResult());
    const failingMethods: BackchannelLogoutReceiverMethods = {
      ...methods,
      recordOpenIDLogoutEvent: jest.fn().mockRejectedValue(new Error('db unavailable')) as never,
    };
    const logger = createLogger();
    const handler = createBackchannelLogoutReceiver({
      methods: failingMethods,
      verifier,
      config: { enabled: true },
      logger,
    });
    const res = createResponse();
    await handler(createRequest({ logout_token: 'good' }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(logger.error).toHaveBeenCalledTimes(1);
    const loggedArgs = logger.error.mock.calls[0];
    expect(JSON.stringify(loggedArgs)).not.toContain('good');
    expect(JSON.stringify(loggedArgs)).not.toContain('db unavailable');
  });

  it('returns 500 when the deadline is exceeded', async () => {
    const verifier: BackchannelLogoutVerifier = jest
      .fn()
      .mockImplementation(() => new Promise(() => undefined));
    const logger = createLogger();
    const handler = createBackchannelLogoutReceiver({
      methods,
      verifier,
      config: { enabled: true, deadlineMs: 10 },
      logger,
    });
    const res = createResponse();
    await handler(createRequest({ logout_token: 'good' }), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});
