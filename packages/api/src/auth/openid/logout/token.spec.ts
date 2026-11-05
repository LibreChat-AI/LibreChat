import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';
import type { JWTVerifyGetKey, KeyLike } from 'jose';
import type { BackchannelLogoutVerifier } from './token';
import { BACKCHANNEL_LOGOUT_EVENT, createBackchannelLogoutVerifier } from './token';

const ISSUER = 'https://issuer.example';
const CLIENT_ID = 'client-1';
const MAX_AGE_SECONDS = 120;
const NOW = new Date('2024-01-01T00:10:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);

type SignableClaims = Record<string, unknown>;

let getKey: JWTVerifyGetKey;
let otherGetKey: JWTVerifyGetKey;
let privateKey: KeyLike;
let otherPrivateKey: KeyLike;
let verify: BackchannelLogoutVerifier;

async function sign(
  claims: SignableClaims,
  { alg = 'RS256', key = privateKey }: { alg?: string; key?: KeyLike } = {},
): Promise<string> {
  return new SignJWT(claims).setProtectedHeader({ alg }).sign(key);
}

function baseClaims(overrides: SignableClaims = {}): SignableClaims {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    sub: 'subject-1',
    sid: 'sid-1',
    jti: 'jti-1',
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + 60,
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    ...overrides,
  };
}

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  getKey = createLocalJWKSet({ keys: [{ ...jwk, alg: 'RS256', use: 'sig' }] });

  const otherPair = await generateKeyPair('RS256');
  otherPrivateKey = otherPair.privateKey;
  const otherJwk = await exportJWK(otherPair.publicKey);
  otherGetKey = createLocalJWKSet({ keys: [{ ...otherJwk, alg: 'RS256', use: 'sig' }] });
});

beforeEach(() => {
  verify = createBackchannelLogoutVerifier({
    getKey,
    issuer: ISSUER,
    clientId: CLIENT_ID,
    algorithms: ['RS256'],
    maxAgeSeconds: MAX_AGE_SECONDS,
    now: () => NOW,
  });
});

describe('createBackchannelLogoutVerifier', () => {
  it('accepts a well-formed token', async () => {
    const token = await sign(baseClaims());
    const result = await verify(token);
    expect(result).toEqual({
      ok: true,
      token: {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        subject: 'subject-1',
        sid: 'sid-1',
        jti: 'jti-1',
        iat: NOW_SECONDS,
      },
    });
  });

  it('rejects a bad signature', async () => {
    const token = await sign(baseClaims(), { key: otherPrivateKey });
    await expect(verify(token)).resolves.toEqual({ ok: false, code: 'invalid_signature' });
  });

  it('rejects a key that does not resolve from the configured JWKS', async () => {
    const otherVerify = createBackchannelLogoutVerifier({
      getKey: otherGetKey,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      algorithms: ['RS256'],
      maxAgeSeconds: MAX_AGE_SECONDS,
      now: () => NOW,
    });
    const token = await sign(baseClaims());
    await expect(otherVerify(token)).resolves.toEqual({ ok: false, code: 'invalid_signature' });
  });

  it('rejects the wrong issuer', async () => {
    const token = await sign(baseClaims({ iss: 'https://not-the-issuer.example' }));
    await expect(verify(token)).resolves.toEqual({ ok: false, code: 'invalid_issuer' });
  });

  it('rejects the wrong audience', async () => {
    const token = await sign(baseClaims({ aud: 'some-other-client' }));
    await expect(verify(token)).resolves.toEqual({ ok: false, code: 'invalid_audience' });
  });

  it('rejects an expired token', async () => {
    const token = await sign(baseClaims({ exp: NOW_SECONDS - 10 }));
    await expect(verify(token)).resolves.toEqual({ ok: false, code: 'expired' });
  });

  it('tolerates expiry within the clock-skew tolerance', async () => {
    const token = await sign(baseClaims({ exp: NOW_SECONDS - 3 }));
    const result = await verify(token);
    expect(result.ok).toBe(true);
  });

  it('rethrows an operational JWKS error instead of mapping it to a rejection code', async () => {
    const token = await sign(baseClaims());
    const timeoutError = Object.assign(new Error('JWKS request timed out'), {
      code: 'ERR_JWKS_TIMEOUT',
    });
    const failingGetKey: JWTVerifyGetKey = jest.fn().mockRejectedValue(timeoutError);
    const failingVerify = createBackchannelLogoutVerifier({
      getKey: failingGetKey,
      issuer: ISSUER,
      clientId: CLIENT_ID,
      algorithms: ['RS256'],
      maxAgeSeconds: MAX_AGE_SECONDS,
      now: () => NOW,
    });
    await expect(failingVerify(token)).rejects.toMatchObject({ code: 'ERR_JWKS_TIMEOUT' });
  });

  it('rejects an iat older than the configured max age', async () => {
    const token = await sign(baseClaims({ iat: NOW_SECONDS - MAX_AGE_SECONDS - 10 }));
    await expect(verify(token)).resolves.toEqual({ ok: false, code: 'iat_too_old' });
  });

  it('rejects a missing jti', async () => {
    const claims = baseClaims();
    delete claims.jti;
    const token = await sign(claims);
    await expect(verify(token)).resolves.toEqual({ ok: false, code: 'missing_jti' });
  });

  it('rejects a missing sub', async () => {
    const claims = baseClaims({ sid: undefined });
    delete claims.sub;
    delete claims.sid;
    const token = await sign(claims);
    await expect(verify(token)).resolves.toEqual({ ok: false, code: 'missing_subject' });
  });

  it('rejects a sid-only token (no sub) as a bad request, not a valid logout', async () => {
    const claims = baseClaims();
    delete claims.sub;
    const token = await sign(claims);
    await expect(verify(token)).resolves.toEqual({ ok: false, code: 'missing_subject' });
  });

  it('rejects a missing events claim', async () => {
    const claims = baseClaims();
    delete claims.events;
    const token = await sign(claims);
    await expect(verify(token)).resolves.toEqual({ ok: false, code: 'missing_events' });
  });

  it('rejects an events claim without the backchannel-logout member', async () => {
    const token = await sign(baseClaims({ events: { 'urn:some:other:event': {} } }));
    await expect(verify(token)).resolves.toEqual({ ok: false, code: 'missing_events' });
  });

  it('rejects a token carrying a nonce', async () => {
    const token = await sign(baseClaims({ nonce: 'should-not-be-here' }));
    await expect(verify(token)).resolves.toEqual({ ok: false, code: 'unexpected_nonce' });
  });

  it('rejects an algorithm outside the configured allow-list', async () => {
    const token = await sign(baseClaims(), { alg: 'PS256' });
    await expect(verify(token)).resolves.toEqual({ ok: false, code: 'disallowed_algorithm' });
  });

  it('rejects a malformed token', async () => {
    await expect(verify('not-a-jwt')).resolves.toEqual({ ok: false, code: 'malformed' });
  });
});
