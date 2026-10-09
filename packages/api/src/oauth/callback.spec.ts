import type { NextFunction, Response } from 'express';
import {
  createOpenIDCallbackAuthenticator,
  logOpenIDCallbackFailure,
  redirectToAuthFailure,
  type OpenIDCallbackRequest,
  type OpenIDCallbackAuthenticatorOptions,
} from './callback';

type CallbackFn = (err: unknown, user: unknown, info: unknown) => void;
type TestRequest = OpenIDCallbackRequest;

const logger = {
  warn: jest.fn(),
  error: jest.fn(),
};

function createRequest(overrides: Partial<TestRequest> = {}): TestRequest {
  return {
    headers: {},
    method: 'GET',
    path: '/openid/callback',
    originalUrl: '/openid/callback',
    query: {},
    ...overrides,
  } as TestRequest;
}

function createResponse(): Response {
  return {
    redirect: jest.fn(),
  } as unknown as Response;
}

function createNext(): jest.MockedFunction<NextFunction> {
  return jest.fn() as jest.MockedFunction<NextFunction>;
}

function createAuthenticator(
  callbackHandler: (
    callback: CallbackFn,
    req: TestRequest,
    res: Response,
    next: NextFunction,
  ) => void,
) {
  const passport = {
    authenticate: jest.fn((_strategy: 'openid', _options, callback: CallbackFn) => {
      return (req: TestRequest, res: Response, next: NextFunction) => {
        callbackHandler(callback, req, res, next);
      };
    }),
  };
  const options: OpenIDCallbackAuthenticatorOptions = {
    passport,
    logger,
    clientDomain: 'http://client.test',
    authFailedError: 'auth_failed',
  };

  return {
    middleware: createOpenIDCallbackAuthenticator(options),
    passport,
  };
}

describe('OpenID OAuth callback helpers', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('redirects failed auth attempts to the login failure URL', () => {
    const res = createResponse();

    redirectToAuthFailure(res, {
      clientDomain: 'http://client.test',
      authFailedError: 'auth_failed',
    });

    expect(res.redirect).toHaveBeenCalledWith(
      'http://client.test/login?redirect=false&error=auth_failed',
    );
  });

  it('logs OpenID callback failures with structured OAuth context', () => {
    const req = createRequest({
      query: {
        code: 'secret-code',
        state: 'secret-state',
      },
    });
    const error = Object.assign(new Error('invalid response encountered'), {
      code: 'OAUTH_INVALID_RESPONSE',
      name: 'ClientError',
    });

    logOpenIDCallbackFailure({
      logger,
      req,
      err: error,
      info: { message: 'provider info' },
    });

    expect(logger.warn).toHaveBeenCalledWith(
      '[OpenID OAuth] Callback authentication failed',
      expect.objectContaining({
        provider: 'openid',
        code: 'OAUTH_INVALID_RESPONSE',
        name: 'ClientError',
        message: 'invalid response encountered',
        has_code: true,
        has_state: true,
      }),
    );
  });

  it('continues the successful callback path after logging in without a session', () => {
    const user = { id: 'user-1' };
    const req = createRequest();
    const res = createResponse();
    const next = createNext();
    const logIn = jest.fn((loginUser, _options, done) => {
      req.user = loginUser;
      done();
    });
    req.logIn = logIn;
    const { middleware, passport } = createAuthenticator((callback) =>
      callback(null, user, { message: 'ok' }),
    );

    middleware(req, res, next);

    expect(passport.authenticate).toHaveBeenCalledWith(
      'openid',
      { failureMessage: true, session: false },
      expect.any(Function),
    );
    expect(logIn).toHaveBeenCalledWith(user, { session: false }, expect.any(Function));
    expect(req.user).toBe(user);
    expect(next).toHaveBeenCalledWith();
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('sets req.user and continues when req.logIn is unavailable', () => {
    const user = { id: 'user-1' };
    const req = createRequest();
    const res = createResponse();
    const next = createNext();
    const { middleware } = createAuthenticator((callback) => callback(null, user, undefined));

    middleware(req, res, next);

    expect(req.user).toBe(user);
    expect(next).toHaveBeenCalledWith();
  });

  it('logs OpenID protocol failures and redirects without escalating', () => {
    const req = createRequest({
      query: {
        code: 'secret-code',
        state: 'secret-state',
      },
    });
    const res = createResponse();
    const next = createNext();
    const error = Object.assign(new Error('invalid response encountered'), {
      code: 'OAUTH_INVALID_RESPONSE',
      name: 'ClientError',
    });
    const { middleware } = createAuthenticator((callback) => callback(error, false, undefined));

    middleware(req, res, next);

    expect(logger.warn).toHaveBeenCalledWith(
      '[OpenID OAuth] Callback authentication failed',
      expect.objectContaining({
        provider: 'openid',
        code: 'OAUTH_INVALID_RESPONSE',
        name: 'ClientError',
        message: 'invalid response encountered',
        has_code: true,
        has_state: true,
      }),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'http://client.test/login?redirect=false&error=auth_failed',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('logs unexpected OpenID errors with context before escalating', () => {
    const req = createRequest({
      query: {
        code: 'secret-code',
        state: 'secret-state',
      },
    });
    const res = createResponse();
    const next = createNext();
    const error = Object.assign(new Error('database exploded'), {
      name: 'DatabaseError',
    });
    const { middleware } = createAuthenticator((callback) => callback(error, false, undefined));

    middleware(req, res, next);

    expect(logger.error).toHaveBeenCalledWith(
      '[OpenID OAuth] Callback authentication error',
      expect.objectContaining({
        provider: 'openid',
        name: 'DatabaseError',
        message: 'database exploded',
        has_code: true,
        has_state: true,
      }),
    );
    expect(next).toHaveBeenCalledWith(error);
    expect(res.redirect).not.toHaveBeenCalled();
  });

  it('logs Passport info failures and redirects without escalating', () => {
    const req = createRequest();
    const res = createResponse();
    const next = createNext();
    const { middleware } = createAuthenticator((callback) =>
      callback(null, false, {
        code: 'DOMAIN_DENIED',
        message: 'Email domain not allowed',
      }),
    );

    middleware(req, res, next);

    expect(logger.warn).toHaveBeenCalledWith(
      '[OpenID OAuth] Callback authentication failed',
      expect.objectContaining({
        provider: 'openid',
        code: 'DOMAIN_DENIED',
        message: 'Email domain not allowed',
      }),
    );
    expect(res.redirect).toHaveBeenCalledWith(
      'http://client.test/login?redirect=false&error=auth_failed',
    );
    expect(next).not.toHaveBeenCalled();
  });

  it('logs login errors and sends them to the error handler', () => {
    const user = { id: 'user-1' };
    const req = createRequest();
    const res = createResponse();
    const next = createNext();
    const error = Object.assign(new Error('login failed'), {
      name: 'LoginError',
    });
    req.logIn = jest.fn((_loginUser, _options, done) => done(error));
    const { middleware } = createAuthenticator((callback) =>
      callback(null, user, { message: 'provider info' }),
    );

    middleware(req, res, next);

    expect(logger.error).toHaveBeenCalledWith(
      '[OpenID OAuth] Callback authentication error',
      expect.objectContaining({
        provider: 'openid',
        name: 'LoginError',
        message: 'login failed',
      }),
    );
    expect(next).toHaveBeenCalledWith(error);
  });
});
