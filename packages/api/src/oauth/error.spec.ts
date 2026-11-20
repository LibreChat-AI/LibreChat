import type { NextFunction, Response } from 'express';
import type { OAuthFailureRequest } from './failure';
import { createOAuthErrorHandler } from './error';

const logger = { warn: jest.fn() };

function createRequest(overrides: Partial<OAuthFailureRequest> = {}): OAuthFailureRequest {
  return {
    headers: {},
    method: 'GET',
    path: '/error',
    originalUrl: '/oauth/error',
    query: {},
    ...overrides,
  };
}

function createResponse(): Response {
  return { redirect: jest.fn() } as unknown as Response;
}

function createNext(): jest.MockedFunction<NextFunction> {
  return jest.fn() as jest.MockedFunction<NextFunction>;
}

const handler = createOAuthErrorHandler({
  logger,
  clientDomain: 'http://client.test',
  authFailedError: 'auth_failed',
});

describe('createOAuthErrorHandler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it.each([
    ['a connect failure code', { error: 'invalid_state', flow: 'flow-a' }],
    ['a provider error', { error: 'access_denied', error_description: 'Denied by provider' }],
    ['a repeated error parameter', { error: ['access_denied', 'invalid_state'] }],
  ])('passes %s through to the app shell', (_name, query) => {
    const res = createResponse();
    const next = createNext();

    handler(createRequest({ query }), res, next);

    expect(next).toHaveBeenCalledWith();
    expect(res.redirect).not.toHaveBeenCalled();
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs the passport message and sends a social login failure to the login screen', () => {
    const req = createRequest({
      headers: { 'x-forwarded-for': '203.0.113.10' },
      session: { messages: ['Unauthorized'] },
    });
    const res = createResponse();
    const next = createNext();

    handler(req, res, next);

    expect(logger.warn).toHaveBeenCalledWith(
      '[OAuth] Authentication failed',
      expect.objectContaining({
        provider: 'unknown',
        message: 'Unauthorized',
        has_code: false,
        has_state: false,
        forwarded_for: '203.0.113.10',
      }),
    );
    expect(JSON.stringify(logger.warn.mock.calls[0])).not.toContain('Unknown OAuth error');
    expect(res.redirect).toHaveBeenCalledWith(
      'http://client.test/login?redirect=false&error=auth_failed',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it.each([[''], ['   ']])('treats a blank error value %j as a social login failure', (error) => {
    const res = createResponse();
    const next = createNext();

    handler(createRequest({ query: { error } }), res, next);

    expect(res.redirect).toHaveBeenCalledWith(
      'http://client.test/login?redirect=false&error=auth_failed',
    );
    expect(next).not.toHaveBeenCalled();
  });
});
