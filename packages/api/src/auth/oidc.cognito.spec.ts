import jwt from 'jsonwebtoken';
import { Types } from 'mongoose';
import { createServer } from 'http';
import { generateKeyPairSync } from 'crypto';
import { getTenantId } from '@librechat/data-schemas';
import type { AppConfig, IUser } from '@librechat/data-schemas';
import type { Server, ServerResponse } from 'http';
import type { Request, Response } from 'express';
import type { JwtPayload } from 'jsonwebtoken';
import type { AddressInfo } from 'net';
import { clearOidcAccessTokenCache, verifyOidcAccessToken } from './oidc';
import { createAgentManagementAuth } from '../middleware/management';

const CLIENT_ID = 'cognito-machine-client';
const USER_ID = '507f1f77bcf86cd799439011';
const TENANT_ID = 'tenant-a';
const REQUIRED_SCOPE = 'agents-api/manage';
const KEY_ID = 'cognito-access-key';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicJwk = {
  ...keyPair.publicKey.export({ format: 'jwk' }),
  alg: 'RS256',
  kid: KEY_ID,
  use: 'sig',
};

let issuer: string;
let server: Server;

function sendJson(res: ServerResponse, body: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function signAccessToken(overrides: JwtPayload = {}): string {
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      sub: CLIENT_ID,
      iss: issuer,
      client_id: CLIENT_ID,
      token_use: 'access',
      scope: `${REQUIRED_SCOPE} another-scope`,
      iat: now,
      exp: now + 300,
      ...overrides,
    },
    keyPair.privateKey,
    { algorithm: 'RS256', keyid: KEY_ID },
  );
}

function createConfig(): AppConfig {
  return {
    endpoints: {
      agents: {
        managementApi: {
          auth: {
            oidc: {
              enabled: true,
              issuer,
              tokenUse: 'access',
              requiredScopes: [REQUIRED_SCOPE],
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

function createUser(): IUser {
  return {
    _id: new Types.ObjectId(USER_ID),
    email: 'integration@example.com',
    name: 'Integration',
    username: 'integration',
    provider: 'local',
    role: 'USER',
    tenantId: TENANT_ID,
  } as IUser;
}

function createResponse(): Response {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  return res as unknown as Response;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/.well-known/openid-configuration') {
      sendJson(res, { issuer, jwks_uri: `${issuer}/.well-known/jwks.json` });
      return;
    }
    if (req.url === '/.well-known/jwks.json') {
      sendJson(res, { keys: [publicJwk] });
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  issuer = `http://127.0.0.1:${address.port}`;
});

afterEach(() => {
  clearOidcAccessTokenCache();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

it('verifies a Cognito-shaped access token through discovery and JWKS', async () => {
  await expect(
    verifyOidcAccessToken(signAccessToken(), {
      issuer,
      tokenUse: 'access',
      requiredScopes: [REQUIRED_SCOPE],
    }),
  ).resolves.toMatchObject({
    sub: CLIENT_ID,
    client_id: CLIENT_ID,
    token_use: 'access',
    scope: `${REQUIRED_SCOPE} another-scope`,
  });
});

it.each([
  ['an ID token', { token_use: 'id' }],
  ['a missing required scope', { scope: 'another-scope' }],
  ['a different issuer', { iss: 'https://other-issuer.example.com' }],
  ['an expired token', { exp: Math.floor(Date.now() / 1000) - 1 }],
])('rejects %s after real signature verification', async (_case, overrides) => {
  await expect(
    verifyOidcAccessToken(signAccessToken(overrides), {
      issuer,
      tokenUse: 'access',
      requiredScopes: [REQUIRED_SCOPE],
    }),
  ).rejects.toThrow();
});

it('authenticates and binds a Cognito machine client to its configured tenant user', async () => {
  const findUser = jest.fn().mockImplementation(async () => {
    expect(getTenantId()).toBe(TENANT_ID);
    return createUser();
  });
  const middleware = createAgentManagementAuth({
    getAppConfig: jest.fn().mockResolvedValue(createConfig()),
    findUser,
    isPrincipalActive: jest.fn().mockResolvedValue(true),
  });
  const req = {
    headers: { authorization: `Bearer ${signAccessToken()}` },
  } as Request;
  const res = createResponse();
  const next = jest.fn();

  await middleware(req, res, next);

  expect(findUser).toHaveBeenCalledWith({ _id: USER_ID, tenantId: TENANT_ID });
  expect(req.user).toMatchObject({ id: USER_ID, tenantId: TENANT_ID, role: 'USER' });
  expect((req as Request & { authStrategy?: string }).authStrategy).toBe('agentManagementM2M');
  expect(next).toHaveBeenCalledTimes(1);
  expect(res.status).not.toHaveBeenCalled();
});

it('rejects a valid token whose signed client ID has no configured binding', async () => {
  const findUser = jest.fn();
  const middleware = createAgentManagementAuth({
    getAppConfig: jest.fn().mockResolvedValue(createConfig()),
    findUser,
    isPrincipalActive: jest.fn(),
  });
  const req = {
    headers: {
      authorization: `Bearer ${signAccessToken({
        sub: 'other-client',
        client_id: 'other-client',
      })}`,
    },
  } as Request;
  const res = createResponse();
  const next = jest.fn();

  await middleware(req, res, next);

  expect(findUser).not.toHaveBeenCalled();
  expect(res.status).toHaveBeenCalledWith(401);
  expect(next).not.toHaveBeenCalled();
});
