import { createHash, generateKeyPairSync, verify as cryptoVerify } from 'crypto';
import type { KeyObject } from 'crypto';
import type { ServerRequest } from '~/types';
import { assertCodeApiJwtSigningReady, getCodeApiAuthHeaders, mintCodeApiToken } from './codeapi';

jest.mock(
  '@librechat/data-schemas',
  () => ({
    getTenantId: jest.fn(),
    SYSTEM_TENANT_ID: '__SYSTEM__',
  }),
  { virtual: true },
);

jest.mock('~/utils', () => ({
  isEnabled: (value?: string) => value === 'true' || value === '1',
}));

const mockGetTenantId = jest.requireMock('@librechat/data-schemas').getTenantId as jest.Mock;

const ENV_KEYS = [
  'CODEAPI_AUTH_PROVIDER',
  'CODEAPI_JWT_ENABLED',
  'CODEAPI_JWT_PRIVATE_KEY',
  'CODEAPI_JWT_PRIVATE_KEY_BASE64',
  'CODEAPI_JWT_PRIVATE_JWK_JSON',
  'CODEAPI_JWT_ALGORITHM',
  'CODEAPI_JWT_KID',
  'CODEAPI_JWT_KEY_ID',
  'CODEAPI_JWT_ISSUER',
  'CODEAPI_JWT_AUDIENCE',
  'CODEAPI_JWT_TTL_SECONDS',
  'CODEAPI_JWT_MINT_CACHE_SECONDS',
  'CODEAPI_JWT_SINGLE_TENANT_ID',
  'TENANT_ISOLATION_STRICT',
  'OPENID_REUSE_TOKENS',
] as const;

type Claims = Record<string, unknown>;

function baseRequest(overrides: Record<string, unknown> = {}): ServerRequest {
  return {
    user: {
      _id: { toString: () => 'user_123' },
      tenantId: 'tenant_abc',
      role: 'USER',
      provider: 'local',
      ...overrides,
    },
    body: { tenant_id: 'spoofed_tenant' },
    headers: { 'x-tenant-id': 'spoofed_header_tenant' },
  } as unknown as ServerRequest;
}

function decodeToken(token: string): {
  header: Claims;
  claims: Claims;
  signingInput: string;
  signature: Buffer;
} {
  const [header, payload, signature] = token.split('.') as [string, string, string];
  return {
    header: JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as Claims,
    claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Claims,
    signingInput: `${header}.${payload}`,
    signature: Buffer.from(signature, 'base64url'),
  };
}

function expectedContextHash(input: {
  userId: string;
  tenantId: string;
  role: string;
  principalSource: string;
  orgId?: string;
  serviceId?: string;
  chcUserId?: string;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        chc_user_id: input.chcUserId ?? '',
        org_id: input.orgId ?? '',
        principal_source: input.principalSource,
        role: input.role,
        service_id: input.serviceId ?? '',
        sub: input.userId,
        tenant_id: input.tenantId,
      }),
    )
    .digest('hex');
}

describe('Code API JWT minting', () => {
  const originalEnv = new Map<string, string | undefined>();
  let publicKey: KeyObject;

  beforeAll(() => {
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
    }
  });

  beforeEach(() => {
    const keyPair = generateKeyPairSync('ed25519');
    publicKey = keyPair.publicKey;
    process.env.CODEAPI_AUTH_PROVIDER = 'librechat-jwt';
    process.env.CODEAPI_JWT_PRIVATE_JWK_JSON = JSON.stringify(
      keyPair.privateKey.export({ format: 'jwk' }),
    );
    process.env.CODEAPI_JWT_ALGORITHM = 'EdDSA';
    process.env.CODEAPI_JWT_KID = 'test-kid';
    process.env.CODEAPI_JWT_ISSUER = 'librechat';
    process.env.CODEAPI_JWT_AUDIENCE = 'codeapi';
    process.env.CODEAPI_JWT_TTL_SECONDS = '300';
    process.env.CODEAPI_JWT_MINT_CACHE_SECONDS = '30';
    delete process.env.CODEAPI_JWT_PRIVATE_KEY;
    delete process.env.CODEAPI_JWT_PRIVATE_KEY_BASE64;
    delete process.env.CODEAPI_JWT_SINGLE_TENANT_ID;
    delete process.env.TENANT_ISOLATION_STRICT;
    delete process.env.OPENID_REUSE_TOKENS;
    mockGetTenantId.mockReset();
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('mints a Code API-scoped token from canonical LibreChat JWT context', async () => {
    jest.spyOn(Date, 'now').mockReturnValue(1_778_250_000_000);

    const token = await mintCodeApiToken(baseRequest());
    const decoded = decodeToken(token);

    expect(decoded.header).toEqual({
      alg: 'EdDSA',
      typ: 'JWT',
      kid: 'test-kid',
    });
    expect(
      cryptoVerify(null, Buffer.from(decoded.signingInput), publicKey, decoded.signature),
    ).toBe(true);
    expect(decoded.claims).toMatchObject({
      iss: 'librechat',
      aud: 'codeapi',
      sub: 'user_123',
      iat: 1_778_250_000,
      nbf: 1_778_250_000,
      exp: 1_778_250_300,
      tenant_id: 'tenant_abc',
      role: 'USER',
      principal_source: 'librechat_jwt',
    });
    expect(decoded.claims.auth_context_hash).toBe(
      expectedContextHash({
        userId: 'user_123',
        tenantId: 'tenant_abc',
        role: 'USER',
        principalSource: 'librechat_jwt',
      }),
    );
    expect(decoded.claims).not.toHaveProperty('refresh_token');
    expect(decoded.claims).not.toHaveProperty('openid_token');
  });

  it('validates that the configured signing key is usable by the selected algorithm', () => {
    expect(() => assertCodeApiJwtSigningReady()).not.toThrow();

    const rsaKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
    process.env.CODEAPI_JWT_PRIVATE_JWK_JSON = JSON.stringify(
      rsaKeyPair.privateKey.export({ format: 'jwk' }),
    );
    process.env.CODEAPI_JWT_ALGORITHM = 'EdDSA';

    expect(() => assertCodeApiJwtSigningReady()).toThrow();
  });

  it('marks OpenID reuse callers without forwarding upstream credentials', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';
    const req = baseRequest({
      provider: 'openid',
      idOnTheSource: 'chc_user_123',
      refreshToken: 'do-not-forward',
      accessToken: 'do-not-forward',
    });
    req.authStrategy = 'openidJwt';

    const token = await mintCodeApiToken(req);
    const { claims } = decodeToken(token);

    expect(claims).toMatchObject({
      principal_source: 'openid_reuse',
      chc_user_id: 'chc_user_123',
    });
    expect(JSON.stringify(claims)).not.toContain('do-not-forward');
  });

  it('marks OpenID users authenticated by LibreChat JWT as LibreChat JWT callers', async () => {
    process.env.OPENID_REUSE_TOKENS = 'true';

    const token = await mintCodeApiToken(baseRequest({ provider: 'openid' }));
    const { claims } = decodeToken(token);

    expect(claims.principal_source).toBe('librechat_jwt');
  });

  it('includes optional plan context when present without trusting caller input', async () => {
    const token = await mintCodeApiToken(
      baseRequest({
        subscription: { planId: 'prod_plan_123' },
      }),
    );
    const { claims } = decodeToken(token);

    expect(claims.plan_id).toBe('prod_plan_123');
    expect(claims).not.toHaveProperty('planId');
  });

  it('binds cached Code API tokens to the selected code worker', async () => {
    const req = baseRequest();
    const first = await mintCodeApiToken(req, 'principal-worker-a');
    const second = await mintCodeApiToken(req, 'principal-worker-b');

    expect(decodeToken(first).claims.code_worker_id).toBe('principal-worker-a');
    expect(decodeToken(second).claims.code_worker_id).toBe('principal-worker-b');
    expect(second).not.toBe(first);
  });

  it('does not collide cache entries for colon-containing plans and worker IDs', async () => {
    const first = await mintCodeApiToken(baseRequest({ subscription: { planId: 'basic:a' } }), 'b');
    const second = await mintCodeApiToken(
      baseRequest({ subscription: { planId: 'basic' } }),
      'a:b',
    );

    expect(decodeToken(first).claims).toMatchObject({ plan_id: 'basic:a', code_worker_id: 'b' });
    expect(decodeToken(second).claims).toMatchObject({
      plan_id: 'basic',
      code_worker_id: 'a:b',
    });
    expect(second).not.toBe(first);
  });

  it('uses the single-tenant namespace when tenant context is absent outside strict mode', async () => {
    mockGetTenantId.mockReturnValue(undefined);

    const token = await mintCodeApiToken(baseRequest({ tenantId: undefined }));
    const { claims } = decodeToken(token);

    expect(claims.tenant_id).toBe('legacy');
    expect(claims.auth_context_hash).toBe(
      expectedContextHash({
        userId: 'user_123',
        tenantId: 'legacy',
        role: 'USER',
        principalSource: 'librechat_jwt',
      }),
    );
  });

  it('supports overriding the single-tenant namespace for local deployments', async () => {
    process.env.CODEAPI_JWT_SINGLE_TENANT_ID = 'local-single-tenant';
    mockGetTenantId.mockReturnValue(undefined);

    const token = await mintCodeApiToken(baseRequest({ tenantId: undefined }));
    const { claims } = decodeToken(token);

    expect(claims.tenant_id).toBe('local-single-tenant');
  });

  it('rejects minting without tenant context in strict tenant mode', async () => {
    process.env.TENANT_ISOLATION_STRICT = 'true';
    mockGetTenantId.mockReturnValue(undefined);

    await expect(mintCodeApiToken(baseRequest({ tenantId: undefined }))).rejects.toThrow(
      'Code API JWT auth requires tenant context',
    );
  });

  it('treats the system tenant sentinel as absent tenant context', async () => {
    mockGetTenantId.mockReturnValue('__SYSTEM__');

    const token = await mintCodeApiToken(baseRequest({ tenantId: undefined }));
    const { claims } = decodeToken(token);

    expect(claims.tenant_id).toBe('legacy');
    expect(claims.auth_context_hash).toBe(
      expectedContextHash({
        userId: 'user_123',
        tenantId: 'legacy',
        role: 'USER',
        principalSource: 'librechat_jwt',
      }),
    );
  });

  it('honors the single-tenant override under the system tenant sentinel', async () => {
    process.env.CODEAPI_JWT_SINGLE_TENANT_ID = 'local-single-tenant';
    mockGetTenantId.mockReturnValue('__SYSTEM__');

    const token = await mintCodeApiToken(baseRequest({ tenantId: undefined }));
    const { claims } = decodeToken(token);

    expect(claims.tenant_id).toBe('local-single-tenant');
  });

  it('treats a system tenant sentinel on the user document as absent', async () => {
    mockGetTenantId.mockReturnValue(undefined);

    const token = await mintCodeApiToken(baseRequest({ tenantId: '__SYSTEM__' }));
    const { claims } = decodeToken(token);

    expect(claims.tenant_id).toBe('legacy');
  });

  it('rejects minting under the system tenant sentinel in strict tenant mode', async () => {
    process.env.TENANT_ISOLATION_STRICT = 'true';
    mockGetTenantId.mockReturnValue('__SYSTEM__');

    await expect(mintCodeApiToken(baseRequest({ tenantId: undefined }))).rejects.toThrow(
      'Code API JWT auth requires tenant context',
    );
  });

  it('ignores caller-supplied tenant spoofing fields', async () => {
    const token = await mintCodeApiToken(baseRequest({ tenantId: 'tenant_canonical' }));
    const { claims } = decodeToken(token);

    expect(claims.tenant_id).toBe('tenant_canonical');
    expect(JSON.stringify(claims)).not.toContain('spoofed_tenant');
    expect(JSON.stringify(claims)).not.toContain('spoofed_header_tenant');
  });

  it('caches minted tokens for at most the configured 30 second window', async () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_778_250_000_000);
    const req = baseRequest();

    const first = await mintCodeApiToken(req);
    const second = await mintCodeApiToken(req);
    now.mockReturnValue(1_778_250_031_000);
    const afterCacheWindow = await mintCodeApiToken(req);

    expect(second).toBe(first);
    expect(afterCacheWindow).not.toBe(first);
  });

  it('returns Authorization headers only when a request and managed auth are present', async () => {
    await expect(getCodeApiAuthHeaders()).resolves.toEqual({});
    await expect(getCodeApiAuthHeaders(baseRequest())).resolves.toEqual({
      Authorization: expect.stringMatching(/^Bearer /),
    });

    process.env.CODEAPI_AUTH_PROVIDER = 'legacy-api-key';
    delete process.env.CODEAPI_JWT_ENABLED;
    await expect(getCodeApiAuthHeaders(baseRequest())).resolves.toEqual({});
  });

  it('does not echo signing material when the private JWK is malformed', async () => {
    process.env.CODEAPI_JWT_PRIVATE_JWK_JSON =
      '{"kty":"OKP","crv":"Ed25519","d":MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgw,"x":"abc"}';

    let failure: unknown;
    try {
      await mintCodeApiToken(baseRequest());
    } catch (caught) {
      failure = caught;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Code API JWT signing key could not be loaded (JWK format)',
    );
    expect((failure as Error).message).not.toContain('MIIEvgIBAD');
  });
});
