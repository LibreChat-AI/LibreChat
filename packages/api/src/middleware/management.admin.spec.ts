import { Types } from 'mongoose';
import { getTenantId } from '@librechat/data-schemas';
import { ManagementAdminScopes } from 'librechat-data-provider';
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { JwtPayload } from 'jsonwebtoken';
import type { ManagementAdminAuthDeps } from './management';
import type { ServerRequest } from '~/types/http';
import {
  isManagementPrincipal,
  createManagementAdminAuth,
  rejectManagementPrincipal,
  unlessManagementPrincipal,
} from './management';
import { getAuditActor } from '../admin/audit';

const USER_ID = '507f1f77bcf86cd799439011';
const TENANT_ID = 'tenant-a';
const CLIENT_ID = 'lms-client';

type Binding = {
  clientId: string;
  userId: string;
  tenantId: string;
  enabled?: boolean;
  adminScopes?: ManagementAdminScopes[];
};

function createConfig(clients: Binding[], enabled = true): AppConfig {
  return {
    endpoints: {
      agents: {
        managementApi: {
          auth: {
            oidc: {
              enabled,
              issuer: 'https://issuer.example.com',
              audience: 'https://agents.example.com',
            },
            clients,
          },
        },
      },
    },
  } as AppConfig;
}

const scopedBinding: Binding = {
  clientId: CLIENT_ID,
  userId: USER_ID,
  tenantId: TENANT_ID,
  enabled: true,
  adminScopes: [ManagementAdminScopes.GROUPS],
};

function createUser(): IUser {
  return {
    _id: new Types.ObjectId(USER_ID),
    name: 'LMS service',
    username: 'lms-service',
    email: 'lms-service@example.com',
    provider: 'local',
    role: 'USER',
    tenantId: TENANT_ID,
  } as IUser;
}

function createPayload(overrides: JwtPayload = {}): JwtPayload {
  return {
    sub: `${CLIENT_ID}@clients`,
    azp: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

function createResponse(): Response {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response;
}

function createDeps(overrides: Partial<ManagementAdminAuthDeps> = {}): ManagementAdminAuthDeps {
  return {
    scope: ManagementAdminScopes.GROUPS,
    getAppConfig: jest.fn().mockResolvedValue(createConfig([scopedBinding])),
    findUser: jest.fn().mockResolvedValue(createUser()),
    isPrincipalActive: jest.fn().mockResolvedValue(true),
    verifyAccessToken: jest.fn().mockResolvedValue(createPayload()),
    fallback: jest.fn((_req, _res, next: NextFunction) => next()) as unknown as RequestHandler,
    ...overrides,
  };
}

async function run(deps: ManagementAdminAuthDeps, authorization = 'Bearer machine-token') {
  const req = { headers: { authorization } } as Request;
  const res = createResponse();
  let tenantInNext: string | undefined;
  const next = jest.fn(() => {
    tenantInNext = getTenantId();
  });
  await createManagementAdminAuth(deps)(req, res, next);
  return { req: req as ServerRequest, res, next, tenantInNext };
}

describe('createManagementAdminAuth', () => {
  it('leaves every request to the session authenticator when no client holds the scope', async () => {
    const deps = createDeps({
      getAppConfig: jest
        .fn()
        .mockResolvedValue(createConfig([{ ...scopedBinding, adminScopes: undefined }])),
    });
    const { req, next } = await run(deps);

    expect(deps.fallback).toHaveBeenCalledTimes(1);
    expect(deps.verifyAccessToken).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);
    expect(isManagementPrincipal(req)).toBe(false);
  });

  it('leaves every request to the session authenticator when management auth is disabled', async () => {
    const deps = createDeps({
      getAppConfig: jest.fn().mockResolvedValue(createConfig([scopedBinding], false)),
    });
    await run(deps);

    expect(deps.fallback).toHaveBeenCalledTimes(1);
    expect(deps.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('passes a token the management issuer did not sign to the session authenticator', async () => {
    const deps = createDeps({
      verifyAccessToken: jest.fn().mockRejectedValue(new Error('invalid signature')),
    });
    const { req } = await run(deps, 'Bearer browser-session-jwt');

    expect(deps.fallback).toHaveBeenCalledTimes(1);
    expect(req.user).toBeUndefined();
  });

  it('passes a request without a bearer token to the session authenticator', async () => {
    const deps = createDeps();
    await run(deps, '');

    expect(deps.fallback).toHaveBeenCalledTimes(1);
    expect(deps.verifyAccessToken).not.toHaveBeenCalled();
  });

  it('passes a verified token of an unbound client to the session authenticator', async () => {
    const deps = createDeps({
      verifyAccessToken: jest
        .fn()
        .mockResolvedValue(createPayload({ azp: 'librechat-web', sub: 'person' })),
    });
    await run(deps);

    expect(deps.fallback).toHaveBeenCalledTimes(1);
  });

  it('authenticates a bound client holding the scope as its user in its tenant', async () => {
    const afterManagementAuth = jest.fn((_req, _res, next: NextFunction) => next());
    const deps = createDeps({ afterManagementAuth });
    const { req, next, tenantInNext } = await run(deps);

    expect(deps.fallback).not.toHaveBeenCalled();
    expect(afterManagementAuth).toHaveBeenCalledTimes(1);
    expect(next).toHaveBeenCalledTimes(1);
    expect(isManagementPrincipal(req)).toBe(true);
    expect(req.managementClientId).toBe(CLIENT_ID);
    expect(String(req.user?._id)).toBe(USER_ID);
    expect(tenantInNext).toBe(TENANT_ID);
    expect(deps.findUser).toHaveBeenCalledWith({ _id: USER_ID, tenantId: TENANT_ID });
  });

  it('refuses a bound client without the route scope with 403 and no session fallback', async () => {
    const deps = createDeps({
      scope: ManagementAdminScopes.SHARES,
      getAppConfig: jest.fn().mockResolvedValue(
        createConfig([
          scopedBinding,
          {
            clientId: 'share-client',
            userId: USER_ID,
            tenantId: TENANT_ID,
            adminScopes: [ManagementAdminScopes.SHARES],
          },
        ]),
      ),
    });
    const { res, next } = await run(deps);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(deps.fallback).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a bound client whose subject does not match with 401', async () => {
    const deps = createDeps({
      verifyAccessToken: jest.fn().mockResolvedValue(createPayload({ sub: 'someone-else' })),
    });
    const { res, next } = await run(deps);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(deps.fallback).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('refuses a bound client whose user is not in the bound tenant with 401', async () => {
    const deps = createDeps({ findUser: jest.fn().mockResolvedValue(null) });
    const { res, next } = await run(deps);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 409 while the bound user is being deleted', async () => {
    const deps = createDeps({ isPrincipalActive: jest.fn().mockResolvedValue(false) });
    const { res } = await run(deps);

    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('management principal route guards', () => {
  const machine = { authStrategy: 'agentManagementM2M' } as unknown as Request;
  const session = { authStrategy: 'jwt' } as unknown as Request;

  it('skips a browser-only middleware for a management client only', () => {
    const middleware = jest.fn();
    const next = jest.fn();
    unlessManagementPrincipal(middleware)(machine, createResponse(), next);
    expect(middleware).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledTimes(1);

    unlessManagementPrincipal(middleware)(session, createResponse(), next);
    expect(middleware).toHaveBeenCalledTimes(1);
  });

  it('refuses a management client on a route outside its scopes', () => {
    const res = createResponse();
    const next = jest.fn();
    rejectManagementPrincipal(machine, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();

    rejectManagementPrincipal(session, createResponse(), next);
    expect(next).toHaveBeenCalledTimes(1);
  });
});

describe('getAuditActor', () => {
  it('records a management client as a service actor named by its client id', () => {
    const req = {
      user: createUser(),
      authStrategy: 'agentManagementM2M',
      managementClientId: CLIENT_ID,
    } as unknown as ServerRequest;
    expect(getAuditActor(req)).toEqual({
      type: 'service',
      id: USER_ID,
      name: `oauth-client:${CLIENT_ID}`,
    });
  });

  it('records a session as the user', () => {
    const req = { user: createUser() } as unknown as ServerRequest;
    expect(getAuditActor(req)).toEqual({ type: 'user', id: USER_ID, name: 'LMS service' });
  });
});
