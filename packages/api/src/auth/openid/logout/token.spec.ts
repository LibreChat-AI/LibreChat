import jwt from 'jsonwebtoken';
import jwksRsa from 'jwks-rsa';
import { generateKeyPairSync } from 'crypto';
import type { JwtPayload } from 'jsonwebtoken';
import type { KeyLike } from 'crypto';
import { validateLogoutToken } from './token';

const ISSUER = 'https://idp.example.com';
const CLIENT_ID = 'librechat';
const KID = 'test-key-1';
const BACKCHANNEL_LOGOUT_EVENT = 'http://schemas.openid.net/event/backchannel-logout';

const keyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });
const publicKeyPem = keyPair.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const otherKeyPair = generateKeyPairSync('rsa', { modulusLength: 2048 });

function baseOptions(overrides: Partial<Parameters<typeof validateLogoutToken>[1]> = {}) {
  return {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    algorithms: ['RS256'],
    clockToleranceSec: 60,
    maxTokenAgeSec: 120,
    resolveKey: jest.fn(async () => publicKeyPem),
    now: () => new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  };
}

function signToken(
  payloadOverrides: Partial<JwtPayload> & Record<string, unknown> = {},
  signOptions: jwt.SignOptions = {},
  privateKey: KeyLike = keyPair.privateKey,
): string {
  const nowSec = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
  const payload = {
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: nowSec,
    jti: 'token-id-1',
    sid: 'session-1',
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    ...payloadOverrides,
  };
  const options: jwt.SignOptions = { algorithm: 'RS256', keyid: KID, ...signOptions };
  if (options.keyid === undefined) {
    delete options.keyid;
  }
  return jwt.sign(payload, privateKey, options);
}

describe('validateLogoutToken', () => {
  it('accepts a valid token without sub', async () => {
    const token = signToken();
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({
      ok: true,
      ref: { issuer: ISSUER, clientId: CLIENT_ID, sid: 'session-1' },
      subject: undefined,
    });
  });

  it('accepts a valid token with sub and passes it through as the subject', async () => {
    const token = signToken({ sub: 'user-42' });
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({
      ok: true,
      ref: { issuer: ISSUER, clientId: CLIENT_ID, sid: 'session-1' },
      subject: 'user-42',
    });
  });

  it('accepts aud as an array containing the client id', async () => {
    const token = signToken({ aud: [CLIENT_ID, 'another-client'] });
    const result = await validateLogoutToken(token, baseOptions());
    expect(result.ok).toBe(true);
  });

  it('rejects a malformed token', async () => {
    const result = await validateLogoutToken('not-a-jwt', baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'malformed' });
  });

  it("rejects algorithm 'none'", async () => {
    const token = jwt.sign(
      {
        iss: ISSUER,
        aud: CLIENT_ID,
        iat: Math.floor(Date.now() / 1000),
        jti: 'token-id-1',
        sid: 'session-1',
        events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      },
      null,
      { algorithm: 'none' },
    );
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'alg_not_permitted' });
  });

  it('rejects an HS256 token when only RS256 is permitted', async () => {
    const token = signToken({}, { algorithm: 'HS256', keyid: undefined }, 'shared-secret');
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'alg_not_permitted' });
  });

  it('rejects a token signed by a different key', async () => {
    const token = signToken({}, {}, otherKeyPair.privateKey);
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'signature_invalid' });
  });

  it('rejects a token carrying a nonce', async () => {
    const token = signToken({ nonce: 'should-not-be-here' });
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'nonce_present' });
  });

  it('rejects a token missing sid', async () => {
    const token = signToken({ sid: undefined });
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'missing_sid' });
  });

  it('rejects a token with an empty sid', async () => {
    const token = signToken({ sid: '' });
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'missing_sid' });
  });

  it('rejects a token missing the back-channel-logout event', async () => {
    const token = signToken({ events: { 'https://example.com/other-event': {} } });
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'missing_backchannel_event' });
  });

  it('rejects a token whose back-channel-logout event value is not an object', async () => {
    const token = signToken({ events: { [BACKCHANNEL_LOGOUT_EVENT]: 'not-an-object' } });
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'missing_backchannel_event' });
  });

  it('rejects a token missing jti', async () => {
    const token = signToken({ jti: undefined });
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'missing_jti' });
  });

  it('rejects a token with a stale iat', async () => {
    const staleIat = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000) - 10_000;
    const token = signToken({ iat: staleIat });
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'stale_iat' });
  });

  it('accepts an iat within maxTokenAgeSec plus clockToleranceSec', async () => {
    const nowSec = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
    const token = signToken({ iat: nowSec - 170 });
    const result = await validateLogoutToken(
      token,
      baseOptions({ maxTokenAgeSec: 120, clockToleranceSec: 60 }),
    );
    expect(result.ok).toBe(true);
  });

  it('rejects a future iat beyond clockToleranceSec', async () => {
    const nowSec = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
    const token = signToken({ iat: nowSec + 61 });
    const result = await validateLogoutToken(token, baseOptions({ clockToleranceSec: 60 }));
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'iat_in_future' });
  });

  it('accepts a future iat within clockToleranceSec', async () => {
    const nowSec = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
    const token = signToken({ iat: nowSec + 60 });
    const result = await validateLogoutToken(token, baseOptions({ clockToleranceSec: 60 }));
    expect(result.ok).toBe(true);
  });

  it('rejects an expired exp claim beyond tolerance', async () => {
    const nowSec = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
    const token = signToken({ exp: nowSec - 1000 });
    const result = await validateLogoutToken(token, baseOptions({ clockToleranceSec: 60 }));
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'expired_claim' });
  });

  it('accepts an exp claim within tolerance', async () => {
    const nowSec = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
    const token = signToken({ exp: nowSec - 10 });
    const result = await validateLogoutToken(token, baseOptions({ clockToleranceSec: 60 }));
    expect(result.ok).toBe(true);
  });

  it('accepts an nbf slightly in the future within clockToleranceSec', async () => {
    const nowSec = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
    const token = signToken({ nbf: nowSec + 10 });
    const result = await validateLogoutToken(token, baseOptions({ clockToleranceSec: 60 }));
    expect(result.ok).toBe(true);
  });

  it('rejects an nbf beyond clockToleranceSec', async () => {
    const nowSec = Math.floor(new Date('2026-01-01T00:00:00Z').getTime() / 1000);
    const token = signToken({ nbf: nowSec + 1000 });
    const result = await validateLogoutToken(token, baseOptions({ clockToleranceSec: 60 }));
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'not_yet_valid' });
  });

  it('accepts a token without an nbf claim, unchanged', async () => {
    const token = signToken();
    const result = await validateLogoutToken(token, baseOptions());
    expect(result.ok).toBe(true);
  });

  it('rejects a mismatched issuer', async () => {
    const token = signToken({ iss: 'https://not-the-idp.example.com' });
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'issuer_mismatch' });
  });

  it('accepts an issuer differing only by a trailing slash', async () => {
    const token = signToken({ iss: `${ISSUER}/` });
    const result = await validateLogoutToken(token, baseOptions());
    expect(result.ok).toBe(true);
  });

  it('accepts a concrete tenant iss against a configured {tenantid} template issuer, keying ref.issuer on the concrete tenant issuer', async () => {
    const templateIssuer = 'https://login.microsoftonline.com/{tenantid}/v2.0';
    const tenantIssuer =
      'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0';
    const token = signToken({ iss: tenantIssuer });
    const result = await validateLogoutToken(token, baseOptions({ issuer: templateIssuer }));
    expect(result).toEqual({
      ok: true,
      ref: { issuer: tenantIssuer, clientId: CLIENT_ID, sid: 'session-1' },
      subject: undefined,
    });
  });

  it('rejects a tenant iss with an extra path segment beyond the template', async () => {
    const templateIssuer = 'https://login.microsoftonline.com/{tenantid}/v2.0';
    const token = signToken({
      iss: 'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/extra/v2.0',
    });
    const result = await validateLogoutToken(token, baseOptions({ issuer: templateIssuer }));
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'issuer_mismatch' });
  });

  it('rejects a tenant iss on a different host than the template', async () => {
    const templateIssuer = 'https://login.microsoftonline.com/{tenantid}/v2.0';
    const token = signToken({
      iss: 'https://attacker.example.com/11111111-2222-3333-4444-555555555555/v2.0',
    });
    const result = await validateLogoutToken(token, baseOptions({ issuer: templateIssuer }));
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'issuer_mismatch' });
  });

  it('rejects a mismatched audience', async () => {
    const token = signToken({ aud: 'another-client' });
    const result = await validateLogoutToken(token, baseOptions());
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'audience_mismatch' });
  });

  it('maps a key-resolution failure to a temporary result', async () => {
    const token = signToken();
    const resolveKey = jest.fn(async () => {
      throw new Error('JWKS endpoint unreachable');
    });
    const result = await validateLogoutToken(token, baseOptions({ resolveKey }));
    expect(result).toEqual({ ok: false, code: 'TEMPORARY', reason: 'key_unavailable' });
  });

  it('maps an unknown kid after a JWKS refetch to an invalid result, not temporary', async () => {
    const token = signToken();
    const resolveKey = jest.fn(async () => {
      throw new jwksRsa.SigningKeyNotFoundError('Unable to find a signing key for kid "unknown"');
    });
    const result = await validateLogoutToken(token, baseOptions({ resolveKey }));
    expect(result).toEqual({ ok: false, code: 'INVALID', reason: 'key_not_found' });
  });

  it('never calls the key resolver for a permanently rejected algorithm', async () => {
    const token = jwt.sign(
      {
        iss: ISSUER,
        aud: CLIENT_ID,
        iat: Math.floor(Date.now() / 1000),
        jti: 'token-id-1',
        sid: 'session-1',
        events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
      },
      null,
      { algorithm: 'none' },
    );
    const resolveKey = jest.fn(async () => publicKeyPem);
    await validateLogoutToken(token, baseOptions({ resolveKey }));
    expect(resolveKey).not.toHaveBeenCalled();
  });
});
