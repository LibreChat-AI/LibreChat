import jwt from 'jsonwebtoken';
import { generateKeyPairSync } from 'crypto';
import { AUTH_SESSION_CHECK_UNAVAILABLE } from 'librechat-data-provider';
import type { ResolvedBackchannelLogoutConfig } from '../providerSession/config';
import { receiveBackchannelLogout, isBackchannelLogoutEnabled } from './receiver';

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'librechat';
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const now = new Date('2026-01-01T00:00:00Z');

function makeConfig(
  overrides: Partial<ResolvedBackchannelLogoutConfig> = {},
): ResolvedBackchannelLogoutConfig {
  return {
    mode: 'enforce',
    algorithms: ['RS256'],
    clockToleranceSec: 60,
    maxTokenAgeSec: 120,
    maxBodyBytes: 16384,
    rateLimit: { windowMs: 60_000, max: 60 },
    processingTimeoutMs: 5000,
    callbackGraceMs: 600_000,
    ...overrides,
  };
}

function makeLogger() {
  return { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
}

function signValidToken(overrides: Record<string, unknown> = {}): string {
  const nowSec = Math.floor(now.getTime() / 1000);
  return jwt.sign(
    {
      iss: ISSUER,
      aud: CLIENT_ID,
      iat: nowSec,
      jti: 'token-id-1',
      sid: 'session-1',
      events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      ...overrides,
    },
    keyPair.privateKey,
    { algorithm: 'RS256', keyid: 'test-key-1' },
  );
}

function makeDeps(overrides: Partial<Parameters<typeof receiveBackchannelLogout>[1]> = {}) {
  return {
    config: makeConfig(),
    client: { issuer: ISSUER, clientId: CLIENT_ID },
    resolveKey: jest.fn(async () => publicKeyPem),
    revokeProviderSession: jest.fn(async () => ({ ok: true as const })),
    logger: makeLogger(),
    now: () => now,
    ...overrides,
  };
}

describe('receiveBackchannelLogout', () => {
  it('returns 400 without writing when the token is missing', async () => {
    const deps = makeDeps();
    const result = await receiveBackchannelLogout(undefined, deps);
    expect(result).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect(deps.revokeProviderSession).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid token without writing', async () => {
    const deps = makeDeps();
    const result = await receiveBackchannelLogout('not-a-jwt', deps);
    expect(result).toEqual({ status: 400, body: { error: 'invalid_request' } });
    expect(deps.revokeProviderSession).not.toHaveBeenCalled();
  });

  it('returns 200 only after the write succeeds, with the expected revoke arguments', async () => {
    const deps = makeDeps();
    const token = signValidToken({ sub: 'user-1' });

    const result = await receiveBackchannelLogout(token, deps);

    expect(result).toEqual({ status: 200 });
    expect(deps.revokeProviderSession).toHaveBeenCalledTimes(1);
    expect(deps.revokeProviderSession).toHaveBeenCalledWith({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      sid: 'session-1',
      subject: 'user-1',
      expiresAt: new Date(
        now.getTime() +
          deps.config.callbackGraceMs +
          deps.config.processingTimeoutMs +
          deps.config.clockToleranceSec * 1000,
      ),
      now,
    });
  });

  it('treats duplicate notifications as harmless, both returning 200', async () => {
    const deps = makeDeps();
    const token = signValidToken();

    const first = await receiveBackchannelLogout(token, deps);
    const second = await receiveBackchannelLogout(token, deps);

    expect(first).toEqual({ status: 200 });
    expect(second).toEqual({ status: 200 });
    expect(deps.revokeProviderSession).toHaveBeenCalledTimes(2);
  });

  it('returns 503 when the database write throws', async () => {
    const deps = makeDeps({
      revokeProviderSession: jest.fn(async () => {
        throw new Error('connection reset');
      }),
    });
    const token = signValidToken();

    const result = await receiveBackchannelLogout(token, deps);

    expect(result).toEqual({ status: 503, body: { code: AUTH_SESSION_CHECK_UNAVAILABLE } });
  });

  it('returns 400 on a subject mismatch', async () => {
    const deps = makeDeps({
      revokeProviderSession: jest.fn(async () => ({
        ok: false as const,
        code: 'SUBJECT_MISMATCH' as const,
      })),
    });
    const token = signValidToken({ sub: 'user-1' });

    const result = await receiveBackchannelLogout(token, deps);

    expect(result).toEqual({ status: 400, body: { error: 'invalid_request' } });
  });

  it('returns 503 and never 200 when processing exceeds the timeout', async () => {
    const deps = makeDeps({
      config: makeConfig({ processingTimeoutMs: 20 }),
      revokeProviderSession: jest.fn(() => new Promise(() => {})),
    });
    const token = signValidToken();

    const result = await receiveBackchannelLogout(token, deps);

    expect(result).toEqual({ status: 503, body: { code: AUTH_SESSION_CHECK_UNAVAILABLE } });
  });
});

describe('isBackchannelLogoutEnabled', () => {
  const client = { issuer: ISSUER, clientId: CLIENT_ID };

  it('is false when mode is off, even with a configured client', () => {
    expect(isBackchannelLogoutEnabled({ mode: 'off' }, client)).toBe(false);
  });

  it('is false when the provider is not configured', () => {
    expect(isBackchannelLogoutEnabled({ mode: 'enforce' }, null)).toBe(false);
  });

  it('is true in record or enforce mode with a configured client', () => {
    expect(isBackchannelLogoutEnabled({ mode: 'record' }, client)).toBe(true);
    expect(isBackchannelLogoutEnabled({ mode: 'enforce' }, client)).toBe(true);
  });
});
