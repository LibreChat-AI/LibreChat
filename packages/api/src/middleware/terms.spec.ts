import { TERMS_NOT_ACCEPTED_CODE } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';
import type { AppConfig } from '@librechat/data-schemas';
import {
  afterTermsGate,
  createTermsBlockCheck,
  createTermsAcceptanceGate,
  allowBeforeTermsAcceptance,
} from './terms';

const configWith = (modalAcceptance?: boolean): AppConfig =>
  ({ interfaceConfig: { termsOfService: { modalAcceptance } } }) as unknown as AppConfig;

function createResponse() {
  const res = {} as Response;
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

function createRequest(
  method: string,
  pathname: string,
  user: Record<string, unknown> | null = { id: 'user-1', role: 'USER' },
) {
  return { method, baseUrl: '', path: pathname, user: user ?? undefined } as unknown as Request;
}

async function run(
  req: Request,
  config: AppConfig | null = configWith(true),
): Promise<{ res: Response; next: jest.Mock; getAppConfig: jest.Mock }> {
  const getAppConfig = jest.fn().mockResolvedValue(config ?? undefined);
  const gate = createTermsAcceptanceGate({ getAppConfig });
  const res = createResponse();
  const next = jest.fn();
  await gate(req, res, next as NextFunction);
  return { res, next, getAppConfig };
}

/** Collapses the gate's effect on the response so each case asserts one value. */
function outcome({ res, next }: { res: Response; next: jest.Mock }): string {
  const status = (res.status as jest.Mock).mock.calls[0]?.[0];
  const body = (res.json as jest.Mock).mock.calls[0]?.[0];
  if (status === 403 && body?.code === TERMS_NOT_ACCEPTED_CODE && next.mock.calls.length === 0) {
    return 'blocked';
  }
  if (status === undefined && next.mock.calls.length === 1 && next.mock.calls[0].length === 0) {
    return 'allowed';
  }
  return 'unexpected';
}

describe('createTermsAcceptanceGate', () => {
  it.each([
    ['POST', '/api/agents/chat/agents'],
    ['POST', '/api/convos/update'],
    ['PUT', '/api/messages/convo-1/msg-1'],
    ['POST', '/api/files'],
    ['DELETE', '/api/convos'],
    ['POST', '/api/agents/v1/chat/completions'],
    ['POST', '/api/auth/2fa/disable'],
    ['POST', '/api/auth/2fa/backup/regenerate'],
    ['POST', '/api/auth/passkey/register'],
    ['PATCH', '/api/auth/passkey/passkey-1'],
    ['DELETE', '/api/auth/passkey/passkey-1'],
  ])('blocks %s %s for a user who has not accepted', async (method, url) => {
    expect(outcome(await run(createRequest(method, url)))).toBe('blocked');
  });

  it('blocks a user whose acceptance was reset', async () => {
    const req = createRequest('POST', '/api/agents/chat/agents', {
      id: 'user-1',
      termsAccepted: false,
      termsAcceptedAt: null,
    });
    expect(outcome(await run(req))).toBe('blocked');
  });

  it.each([
    ['GET', '/api/convos'],
    ['GET', '/api/user'],
    ['GET', '/api/user/terms'],
    ['HEAD', '/api/files'],
    ['OPTIONS', '/api/agents/chat/agents'],
    ['POST', '/api/user/terms/accept'],
    ['POST', '/api/agents/chat/abort'],
    ['POST', '/api/user/terms/accept/'],
    ['POST', '/api/auth/logout'],
    ['POST', '/api/auth/cloudfront/refresh'],
    ['DELETE', '/api/user/delete'],
  ])('allows %s %s without reading config', async (method, url) => {
    const result = await run(createRequest(method, url));
    expect(outcome(result)).toBe('allowed');
    expect(result.getAppConfig).not.toHaveBeenCalled();
  });

  it('does not treat a lookalike path as exempt', async () => {
    expect(outcome(await run(createRequest('POST', '/api/authority')))).toBe('blocked');
    expect(outcome(await run(createRequest('POST', '/api/user/terms/accept-all')))).toBe('blocked');
  });

  it('allows a user who has accepted without reading config', async () => {
    const req = createRequest('POST', '/api/agents/chat/agents', {
      id: 'user-1',
      termsAccepted: true,
    });
    const result = await run(req);
    expect(outcome(result)).toBe('allowed');
    expect(result.getAppConfig).not.toHaveBeenCalled();
  });

  it('allows an unauthenticated request through to the route', async () => {
    expect(outcome(await run(createRequest('POST', '/api/agents/chat/agents', null)))).toBe(
      'allowed',
    );
  });

  it.each([
    ['disabled', configWith(false)],
    ['unset', configWith(undefined)],
    ['missing', {} as AppConfig],
    ['unresolved', null],
  ])('is a no-op when modalAcceptance is %s', async (_label, config) => {
    expect(outcome(await run(createRequest('POST', '/api/agents/chat/agents'), config))).toBe(
      'allowed',
    );
  });

  it("resolves the config for the user's role and tenant", async () => {
    const req = createRequest('POST', '/api/files', {
      id: 'user-1',
      role: 'ADMIN',
      tenantId: 'tenant-a',
    });
    const { getAppConfig } = await run(req);
    expect(getAppConfig).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'ADMIN', userId: 'user-1', tenantId: 'tenant-a' }),
    );
  });

  it('forwards a config failure instead of allowing the write', async () => {
    const error = new Error('config unavailable');
    const gate = createTermsAcceptanceGate({ getAppConfig: jest.fn().mockRejectedValue(error) });
    const res = createResponse();
    const next = jest.fn();
    await gate(createRequest('POST', '/api/files'), res, next);
    expect(next).toHaveBeenCalledWith(error);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('answers in the nested error envelope for remote agent boundaries', async () => {
    const gate = createTermsAcceptanceGate(
      { getAppConfig: jest.fn().mockResolvedValue(configWith(true)) },
      { envelope: 'nested' },
    );
    const res = createResponse();
    await gate(createRequest('POST', '/api/agents/v1/chat/completions'), res, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.objectContaining({
        code: TERMS_NOT_ACCEPTED_CODE,
        type: 'invalid_request_error',
      }),
    });
  });

  it('resolves the config fail-closed so an override lookup failure cannot fall back to the base', async () => {
    const { getAppConfig } = await run(createRequest('POST', '/api/files'));
    expect(getAppConfig).toHaveBeenCalledWith(expect.objectContaining({ failClosed: true }));
  });
});

describe('allowBeforeTermsAcceptance', () => {
  it('lets a router that opts out take writes from a user who has not accepted', async () => {
    const req = createRequest('PATCH', '/api/admin/config/role/USER/fields', {
      id: 'admin-1',
      role: 'ADMIN',
      termsAccepted: false,
    });
    const marked = jest.fn();
    allowBeforeTermsAcceptance(req, createResponse(), marked as NextFunction);
    expect(marked).toHaveBeenCalledWith();

    const { getAppConfig, ...result } = await run(req);
    expect(outcome(result)).toBe('allowed');
    expect(getAppConfig).not.toHaveBeenCalled();
  });

  it('holds only inside the router that opted out, not one the request reaches after it', async () => {
    const req = createRequest('POST', '/admin/config/role/USER/fields', {
      id: 'admin-1',
      role: 'ADMIN',
      termsAccepted: false,
    });
    req.baseUrl = '/api/admin/config';
    allowBeforeTermsAcceptance(req, createResponse(), jest.fn() as NextFunction);

    req.baseUrl = '/api';
    expect(outcome(await run(req))).toBe('blocked');
    req.baseUrl = '/api/admin/config';
    expect(outcome(await run(req))).toBe('allowed');
  });

  it('keeps every request it did not mark gated, on the same path and any other', async () => {
    const user = { id: 'admin-1', role: 'ADMIN', termsAccepted: false };
    const sameRoute = createRequest('PATCH', '/api/admin/config/role/USER/fields', user);
    const chat = createRequest('POST', '/api/agents/chat/agents', user);
    expect(outcome(await run(sameRoute))).toBe('blocked');
    expect(outcome(await run(chat))).toBe('blocked');
  });
});

describe('createTermsBlockCheck', () => {
  const check = (config: AppConfig | undefined) =>
    createTermsBlockCheck({ getAppConfig: jest.fn().mockResolvedValue(config) });

  it('blocks an unaccepted user when modalAcceptance is on, regardless of method', async () => {
    expect(await check(configWith(true))({ id: 'user-1', termsAccepted: false })).toBe(true);
  });

  it.each([
    ['accepted', { id: 'user-1', termsAccepted: true }, configWith(true)],
    ['modalAcceptance off', { id: 'user-1' }, configWith(false)],
    ['no user', undefined, configWith(true)],
  ])('does not block when %s', async (_label, user, config) => {
    expect(await check(config)(user)).toBe(false);
  });
});

describe('afterTermsGate', () => {
  const req = createRequest('POST', '/api/files');

  it('runs the handler after the gate passes', async () => {
    const handler = jest.fn();
    const next = jest.fn();
    const gate = jest.fn((_req, _res, done) => done());
    await afterTermsGate(gate, handler)(req, createResponse(), next);
    expect(handler).toHaveBeenCalledWith(req, expect.anything(), next);
  });

  it('forwards a gate error without running the handler', async () => {
    const error = new Error('config unavailable');
    const handler = jest.fn();
    const next = jest.fn();
    const gate = jest.fn((_req, _res, done) => done(error));
    await afterTermsGate(gate, handler)(req, createResponse(), next);
    expect(next).toHaveBeenCalledWith(error);
    expect(handler).not.toHaveBeenCalled();
  });
});
