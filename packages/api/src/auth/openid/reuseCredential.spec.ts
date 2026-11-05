import jwt from 'jsonwebtoken';
import { createHash } from 'node:crypto';
import type { OpenIDRequest, SessionOpenIDTokens } from './types';
import { getOpenIDCheckIdentity, getValidOpenIDReuseCredential } from './reuseCredential';
import { applyOpenIDAuthGeneration } from './check/generation';

const secret = 'marker-secret';
const identity = {
  id: 'user-A',
  openidIssuer: 'https://issuer.test',
  openidSubject: 'A',
  authGenerationId: 'generation-A',
  tenantId: 'tenant-A',
};
const hash = (value: string) => createHash('sha256').update(value).digest('base64url');
const marker = (refreshToken = 'refresh-A', extra: object = {}) =>
  jwt.sign({ ...identity, refreshTokenHash: hash(refreshToken), ...extra }, secret, {
    expiresIn: 60,
  });
const cookies = () => ({ openid_user_id: marker(), refreshToken: 'refresh-A' });

describe('OpenID identity cookie recovery', () => {
  it('restores only identity and the bound refresh context', () => {
    expect(getOpenIDCheckIdentity(cookies(), secret)).toEqual({
      appUserId: 'user-A',
      openidIssuer: identity.openidIssuer,
      openidSubject: 'A',
      authGenerationId: 'generation-A',
      tenantId: 'tenant-A',
      refreshToken: 'refresh-A',
      browserRefreshToken: 'refresh-A',
    });
  });
  it('keeps legacy credentials usable by existing readers but requires Continue for checks', () => {
    const legacy = {
      openid_user_id: jwt.sign({ id: 'user-A', refreshTokenHash: hash('refresh-A') }, secret),
      refreshToken: 'refresh-A',
    };
    expect(getValidOpenIDReuseCredential(legacy, secret, 'refresh-A')?.userId).toBe('user-A');
    expect(getOpenIDCheckIdentity(legacy, secret)).toBeNull();
  });
  it.each([
    ['missing refresh', { openid_user_id: marker() }],
    ['different refresh', { ...cookies(), refreshToken: 'refresh-B' }],
    ['bad signature', { ...cookies(), openid_user_id: jwt.sign(identity, 'other-secret') }],
    [
      'expired',
      {
        ...cookies(),
        openid_user_id: jwt.sign({ ...identity, refreshTokenHash: hash('refresh-A') }, secret, {
          expiresIn: -1,
        }),
      },
    ],
    [
      'missing issuer',
      { ...cookies(), openid_user_id: marker('refresh-A', { openidIssuer: undefined }) },
    ],
    [
      'missing subject',
      { ...cookies(), openid_user_id: marker('refresh-A', { openidSubject: undefined }) },
    ],
    [
      'missing generation',
      { ...cookies(), openid_user_id: marker('refresh-A', { authGenerationId: undefined }) },
    ],
  ])('rejects %s', (_name, value) => {
    expect(getOpenIDCheckIdentity(value, secret)).toBeNull();
  });
  it('binds renewed metadata to the rotated token', () => {
    const renewed = { openid_user_id: marker('refresh-rotated'), refreshToken: 'refresh-rotated' };
    expect(getOpenIDCheckIdentity(renewed, secret)?.authGenerationId).toBe('generation-A');
    expect(getOpenIDCheckIdentity({ ...renewed, refreshToken: 'refresh-A' }, secret)).toBeNull();
  });
  it('preserves the generation when refresh runs after server-session expiry', () => {
    const req: OpenIDRequest = { cookies: cookies(), session: {} };
    const tokens: SessionOpenIDTokens = {
      ...getOpenIDCheckIdentity(cookies(), secret)!,
      refreshToken: 'rotated',
      authGenerationId: undefined,
    };
    applyOpenIDAuthGeneration(req, tokens, secret);
    expect(tokens.authGenerationId).toBe('generation-A');
    req.openidLoginGeneration = 'generation-new';
    applyOpenIDAuthGeneration(req, tokens, secret);
    expect(tokens.authGenerationId).toBe('generation-new');
  });
  it('does not attach an old cookie generation to a different identity or tenant', () => {
    for (const changed of [
      { appUserId: 'user-B' },
      { openidSubject: 'B' },
      { openidIssuer: 'https://other.test' },
      { tenantId: 'tenant-B' },
    ]) {
      const tokens: SessionOpenIDTokens = {
        ...getOpenIDCheckIdentity(cookies(), secret)!,
        ...changed,
        authGenerationId: undefined,
      };
      applyOpenIDAuthGeneration({ cookies: cookies(), session: {} }, tokens, secret);
      expect(tokens.authGenerationId).toBeUndefined();
    }
  });
});
