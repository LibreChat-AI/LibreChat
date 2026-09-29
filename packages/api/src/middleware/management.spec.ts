import { Types } from 'mongoose';
import { getTenantId } from '@librechat/data-schemas';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { Request, Response, NextFunction } from 'express';
import type { JwtPayload } from 'jsonwebtoken';
import type { AgentManagementAuthDeps } from './management';
import { createAgentManagementAuth, getMachineClientId } from './management';

const USER_ID = '507f1f77bcf86cd799439011';
const TENANT_ID = 'tenant-a';
const CLIENT_ID = 'machine-client';
const TOKEN = 'signed-access-token';

function createConfig(enabled = true): AppConfig {
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
            clients: [
              {
                clientId: CLIENT_ID,
                userId: USER_ID,
                tenantId: TENANT_ID,
                enabled: true,
              },
            ],
          },
        },
      },
    },
  } as AppConfig;
}

function createUser(overrides: Partial<IUser> = {}): IUser {
  return {
    _id: new Types.ObjectId(USER_ID),
    email: 'integration@example.com',
    name: 'Integration',
    username: 'integration',
    provider: 'local',
    role: 'USER',
    tenantId: TENANT_ID,
    ...overrides,
  } as IUser;
}

function createRequest(headers: Request['headers'] = {}): Request {
  return { headers: { authorization: `Bearer ${TOKEN}`, ...headers } } as Request;
}

function createResponse(): Response {
  const res = {
    status: jest.fn(),
    json: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response;
}

function createPayload(overrides: JwtPayload = {}): JwtPayload {
  return {
    iss: 'https://issuer.example.com',
    aud: 'https://agents.example.com',
    sub: `${CLIENT_ID}@clients`,
    azp: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 60,
    ...overrides,
  };
}

function createDeps(overrides: Partial<AgentManagementAuthDeps> = {}): AgentManagementAuthDeps {
  return {
    getAppConfig: jest.fn().mockResolvedValue(createConfig()),
    findUser: jest.fn().mockResolvedValue(createUser()),
    isPrincipalActive: jest.fn().mockResolvedValue(true),
    verifyAccessToken: jest.fn().mockResolvedValue(createPayload()),
    ...overrides,
  };
}

async function runMiddleware(
  deps: AgentManagementAuthDeps,
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> {
  await Promise.resolve(createAgentManagementAuth(deps)(req, res, next));
}

describe('getMachineClientId', () => {
  it.each([
    ['Auth0', { azp: CLIENT_ID }],
    ['RFC 9068', { client_id: CLIENT_ID }],
    ['matching dual-profile', { azp: CLIENT_ID, client_id: CLIENT_ID }],
  ])('accepts the %s client identifier', (_profile, claims) => {
    expect(getMachineClientId(createPayload({ azp: undefined, ...claims }))).toBe(CLIENT_ID);
  });

  it.each([
    ['missing client identifier', { azp: undefined }],
    ['conflicting client identifiers', { azp: CLIENT_ID, client_id: 'other-client' }],
    ['missing expiration', { exp: undefined }],
    ['a non-finite expiration', { exp: Number.POSITIVE_INFINITY }],
    ['expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
  ])('rejects %s', (_case, claims) => {
    expect(() => getMachineClientId(createPayload(claims))).toThrow();
  });

  it('accepts a fractional NumericDate expiration', () => {
    expect(getMachineClientId(createPayload({ exp: Date.now() / 1000 + 60.5 }))).toBe(CLIENT_ID);
  });

  it('accepts a configured provider-specific token subject', async () => {
    const config = createConfig();
    const binding = config.endpoints?.agents?.managementApi?.auth?.clients[0];
    if (binding) binding.subject = 'opaque-service-principal-subject';
    const deps = createDeps({
      getAppConfig: jest.fn().mockResolvedValue(config),
      verifyAccessToken: jest
        .fn()
        .mockResolvedValue(createPayload({ sub: 'opaque-service-principal-subject' })),
    });
    const next = jest.fn();

    await runMiddleware(deps, createRequest(), createResponse(), next);

    expect(next).toHaveBeenCalledTimes(1);
  });

  it('passes Cognito access-token requirements to the verifier', async () => {
    const config = createConfig();
    const oidc = config.endpoints?.agents?.managementApi?.auth?.oidc;
    if (oidc) {
      delete oidc.audience;
      oidc.tokenUse = 'access';
      oidc.requiredScopes = ['agents-api/manage'];
    }
    const deps = createDeps({
      getAppConfig: jest.fn().mockResolvedValue(config),
      verifyAccessToken: jest.fn().mockResolvedValue(
        createPayload({
          azp: undefined,
          client_id: CLIENT_ID,
          sub: CLIENT_ID,
          token_use: 'access',
          scope: 'agents-api/manage',
        }),
      ),
    });
    const next = jest.fn();

    await runMiddleware(deps, createRequest(), createResponse(), next);

    expect(deps.verifyAccessToken).toHaveBeenCalledWith(TOKEN, {
      enabled: true,
      issuer: 'https://issuer.example.com',
      tokenUse: 'access',
      requiredScopes: ['agents-api/manage'],
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['the default subject rule', createConfig(), createPayload({ sub: 'auth0|human-user' })],
    [
      'a configured provider subject',
      (() => {
        const config = createConfig();
        const binding = config.endpoints?.agents?.managementApi?.auth?.clients[0];
        if (binding) binding.subject = 'expected-service-principal';
        return config;
      })(),
      createPayload({ sub: 'other-service-principal' }),
    ],
  ])('rejects a token that violates %s before querying a User', async (_case, config, payload) => {
    const deps = createDeps({
      getAppConfig: jest.fn().mockResolvedValue(config),
      verifyAccessToken: jest.fn().mockResolvedValue(payload),
    });
    const res = createResponse();

    await runMiddleware(deps, createRequest(), res, jest.fn());

    expect(deps.findUser).not.toHaveBeenCalled();
    expect(deps.isPrincipalActive).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });
});

describe('createAgentManagementAuth', () => {
  it('resolves the configured User inside the bound tenant context', async () => {
    let lookupTenant: string | undefined;
    let downstreamTenant: string | undefined;
    const deps = createDeps({
      findUser: jest.fn().mockImplementation(async () => {
        lookupTenant = getTenantId();
        return createUser();
      }),
    });
    const req = createRequest();
    const res = createResponse();
    const next = jest.fn(() => {
      downstreamTenant = getTenantId();
    });

    await runMiddleware(deps, req, res, next);

    expect(deps.getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(deps.verifyAccessToken).toHaveBeenCalledWith(TOKEN, {
      enabled: true,
      issuer: 'https://issuer.example.com',
      audience: 'https://agents.example.com',
    });
    expect(deps.findUser).toHaveBeenCalledWith({ _id: USER_ID, tenantId: TENANT_ID });
    expect(lookupTenant).toBe(TENANT_ID);
    expect(downstreamTenant).toBe(TENANT_ID);
    expect(req.user).toMatchObject({ id: USER_ID, tenantId: TENANT_ID, role: 'USER' });
    expect(req.user).not.toHaveProperty('federatedTokens');
    expect((req as Request & { authStrategy?: string }).authStrategy).toBe('agentManagementM2M');
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  it('accepts a binding with an uppercase User ObjectId', async () => {
    const config = createConfig();
    const binding = config.endpoints?.agents?.managementApi?.auth?.clients[0];
    if (binding) binding.userId = USER_ID.toUpperCase();
    const deps = createDeps({ getAppConfig: jest.fn().mockResolvedValue(config) });
    const next = jest.fn();

    await runMiddleware(deps, createRequest(), createResponse(), next);

    expect(deps.findUser).toHaveBeenCalledWith({
      _id: USER_ID.toUpperCase(),
      tenantId: TENANT_ID,
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['absent', undefined],
    ['malformed', 'Basic credentials'],
    ['empty', 'Bearer   '],
  ])('rejects an %s bearer token before verification', async (_case, authorization) => {
    const deps = createDeps();
    const req = createRequest({ authorization });
    const res = createResponse();
    const next = jest.fn();

    await runMiddleware(deps, req, res, next);

    expect(deps.verifyAccessToken).not.toHaveBeenCalled();
    expect(deps.findUser).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('rejects a verification failure before resolving a binding', async () => {
    const deps = createDeps({
      verifyAccessToken: jest.fn().mockRejectedValue(new Error('invalid signature')),
    });
    const res = createResponse();

    await runMiddleware(deps, createRequest(), res, jest.fn());

    expect(deps.findUser).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('rejects audience-less access-token auth without required scopes before verification', async () => {
    const config = createConfig();
    const oidc = config.endpoints?.agents?.managementApi?.auth?.oidc;
    if (oidc) {
      delete oidc.audience;
      oidc.tokenUse = 'access';
      delete oidc.requiredScopes;
    }
    const deps = createDeps({ getAppConfig: jest.fn().mockResolvedValue(config) });
    const res = createResponse();
    const next = jest.fn();

    await runMiddleware(deps, createRequest(), res, next);

    expect(deps.verifyAccessToken).not.toHaveBeenCalled();
    expect(deps.findUser).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it.each([
    ['unknown', createPayload({ azp: 'unknown', sub: 'unknown@clients' }), createConfig()],
    [
      'disabled',
      createPayload(),
      {
        ...createConfig(),
        endpoints: {
          agents: {
            managementApi: {
              auth: {
                ...createConfig().endpoints?.agents?.managementApi?.auth,
                clients: [
                  {
                    clientId: CLIENT_ID,
                    userId: USER_ID,
                    tenantId: TENANT_ID,
                    enabled: false,
                  },
                ],
              },
            },
          },
        },
      } as AppConfig,
    ],
  ])('rejects an %s client before querying a User', async (_case, payload, config) => {
    const deps = createDeps({
      getAppConfig: jest.fn().mockResolvedValue(config),
      verifyAccessToken: jest.fn().mockResolvedValue(payload),
    });
    const res = createResponse();

    await runMiddleware(deps, createRequest(), res, jest.fn());

    expect(deps.findUser).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('ignores caller-supplied identity and tenant headers', async () => {
    const deps = createDeps();
    const req = createRequest({
      'x-tenant-id': 'forged-tenant',
      'x-user-id': 'forged-user',
      'x-user-role': 'ADMIN',
    });
    let downstreamTenant: string | undefined;

    await runMiddleware(deps, req, createResponse(), () => {
      downstreamTenant = getTenantId();
    });

    expect(downstreamTenant).toBe(TENANT_ID);
    expect(req.user).toMatchObject({ id: USER_ID, tenantId: TENANT_ID, role: 'USER' });
  });

  it.each([
    ['a missing User', null],
    ['a User from another tenant', createUser({ tenantId: 'tenant-b' })],
    ['a different User ID', createUser({ _id: new Types.ObjectId() })],
  ])('fails closed for %s', async (_case, user) => {
    const deps = createDeps({ findUser: jest.fn().mockResolvedValue(user) });
    const res = createResponse();
    const next = jest.fn();

    await runMiddleware(deps, createRequest(), res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('returns the established deletion-fence response for an inactive User', async () => {
    const deps = createDeps({ isPrincipalActive: jest.fn().mockResolvedValue(false) });
    const res = createResponse();

    await runMiddleware(deps, createRequest(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: 'Account deletion is in progress',
      code: 'ACCOUNT_DELETION_IN_PROGRESS',
    });
  });

  it('checks the deletion fence after resolving the bound User', async () => {
    let resolveUser: ((user: IUser) => void) | undefined;
    const findUser = jest.fn(
      () =>
        new Promise<IUser>((resolve) => {
          resolveUser = resolve;
        }),
    );
    const isPrincipalActive = jest.fn().mockResolvedValue(true);
    const deps = createDeps({ findUser, isPrincipalActive });
    const next = jest.fn();

    const pending = runMiddleware(deps, createRequest(), createResponse(), next);
    await Promise.resolve();
    await Promise.resolve();

    expect(findUser).toHaveBeenCalledTimes(1);
    expect(isPrincipalActive).not.toHaveBeenCalled();
    resolveUser?.(createUser());
    await pending;

    expect(isPrincipalActive).toHaveBeenCalledWith(USER_ID);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('does not retain a removed binding after app config reload', async () => {
    const deps = createDeps({
      getAppConfig: jest
        .fn()
        .mockResolvedValueOnce(createConfig())
        .mockResolvedValueOnce(createConfig(false)),
    });
    const firstNext = jest.fn();
    const secondNext = jest.fn();
    const secondResponse = createResponse();

    await runMiddleware(deps, createRequest(), createResponse(), firstNext);
    await runMiddleware(deps, createRequest(), secondResponse, secondNext);

    expect(firstNext).toHaveBeenCalledTimes(1);
    expect(secondResponse.status).toHaveBeenCalledWith(401);
    expect(secondNext).not.toHaveBeenCalled();
  });

  it('keeps concurrent tenant contexts isolated', async () => {
    const tenantBUserId = new Types.ObjectId().toString();
    const config = createConfig();
    const auth = config.endpoints?.agents?.managementApi?.auth;
    auth?.clients.push({
      clientId: 'machine-client-b',
      userId: tenantBUserId,
      tenantId: 'tenant-b',
      enabled: true,
    });
    const deps = createDeps({
      getAppConfig: jest.fn().mockResolvedValue(config),
      verifyAccessToken: jest
        .fn()
        .mockImplementation(async (token) =>
          token === TOKEN
            ? createPayload()
            : createPayload({ azp: 'machine-client-b', sub: 'machine-client-b@clients' }),
        ),
      findUser: jest.fn().mockImplementation(async ({ _id }) => {
        await Promise.resolve();
        return getTenantId() === TENANT_ID
          ? createUser()
          : createUser({ _id: new Types.ObjectId(String(_id)), tenantId: 'tenant-b' });
      }),
    });
    const observed: string[] = [];
    const requestA = createRequest();
    const requestB = createRequest({ authorization: 'Bearer signed-access-token-b' });

    await Promise.all([
      runMiddleware(deps, requestA, createResponse(), () => {
        observed.push(getTenantId() ?? 'missing');
      }),
      runMiddleware(deps, requestB, createResponse(), () => {
        observed.push(getTenantId() ?? 'missing');
      }),
    ]);

    expect(observed.sort()).toEqual([TENANT_ID, 'tenant-b'].sort());
    expect((requestA as Request & { user?: IUser }).user?.tenantId).toBe(TENANT_ID);
    expect((requestB as Request & { user?: IUser }).user?.tenantId).toBe('tenant-b');
  });

  it('returns 500 when base configuration cannot be loaded', async () => {
    const deps = createDeps({
      getAppConfig: jest.fn().mockRejectedValue(new Error('configuration unavailable')),
    });
    const res = createResponse();

    await runMiddleware(deps, createRequest(), res, jest.fn());

    expect(res.status).toHaveBeenCalledWith(500);
    expect(deps.findUser).not.toHaveBeenCalled();
  });
});
