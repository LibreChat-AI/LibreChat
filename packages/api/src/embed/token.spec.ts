import jwt from 'jsonwebtoken';
import type { EmbedApp } from './apps';
import { verifyEmbedToken } from './token';

const app: EmbedApp = {
  id: 'portal',
  allowedOrigins: ['https://portal.example.com'],
  secret: 'a'.repeat(48),
  maxTokenAgeSeconds: 300,
  clockToleranceSeconds: 30,
  sessionSeconds: 900,
};

/** Signs with a two-minute lifetime unless the payload sets its own `exp`. */
const sign = (
  payload: Record<string, unknown>,
  options: jwt.SignOptions = {},
  secret: string = app.secret,
) =>
  jwt.sign({ sub: 'user-1', jti: 'jti-1', ...payload }, secret, {
    algorithm: 'HS256',
    audience: app.id,
    ...('exp' in payload ? {} : { expiresIn: 120 }),
    ...options,
  });

describe('verifyEmbedToken', () => {
  it('returns the identity of a valid token', () => {
    const result = verifyEmbedToken(sign({ name: '  Ada  ' }), app);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toMatchObject({ subject: 'user-1', jti: 'jti-1', name: 'Ada' });
      expect(result.value.expiresAt).toBeGreaterThan(Date.now());
    }
  });

  it('rejects a token signed with another secret', () => {
    expect(verifyEmbedToken(sign({}, {}, 'b'.repeat(48)), app)).toEqual({
      ok: false,
      error: { code: 'invalid_token' },
    });
  });

  it('rejects a token for another app', () => {
    expect(verifyEmbedToken(sign({}, { audience: 'other' }), app).ok).toBe(false);
  });

  it('rejects an algorithm other than HS256', () => {
    const token = jwt.sign({ sub: 'user-1', jti: 'jti-1' }, app.secret, {
      algorithm: 'HS512',
      audience: app.id,
      expiresIn: 120,
    });
    expect(verifyEmbedToken(token, app).ok).toBe(false);
  });

  it('rejects an expired token', () => {
    const iat = Math.floor(Date.now() / 1000) - 600;
    const token = sign({ iat, exp: iat + 60 });
    expect(verifyEmbedToken(token, app).ok).toBe(false);
  });

  it('requires sub, jti and exp', () => {
    const noJti = jwt.sign({ sub: 'user-1' }, app.secret, { audience: app.id, expiresIn: 60 });
    const noExp = jwt.sign({ sub: 'user-1', jti: 'x' }, app.secret, { audience: app.id });
    expect(verifyEmbedToken(noJti, app).ok).toBe(false);
    expect(verifyEmbedToken(noExp, app).ok).toBe(false);
  });

  it('rejects a lifetime longer than the app allows', () => {
    expect(verifyEmbedToken(sign({}, { expiresIn: 3600 }), app)).toEqual({
      ok: false,
      error: { code: 'token_lifetime_too_long' },
    });
  });

  it('rejects a token pre-signed with a future iat', () => {
    const iat = Math.floor(Date.now() / 1000) + 86400;
    const token = sign({ iat, exp: iat + 60 });
    expect(verifyEmbedToken(token, app)).toEqual({
      ok: false,
      error: { code: 'token_lifetime_too_long' },
    });
  });
});
