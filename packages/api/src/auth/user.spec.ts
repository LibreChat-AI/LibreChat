import type { IUser } from '@librechat/data-schemas';
import { PUBLIC_USER_RESPONSE_FIELDS, sanitizeUserForResponse } from './user';
import { sanitizeUserForAuthResponse } from './localRefresh';

describe('sanitizeUserForAuthResponse', () => {
  it.each(['lean', 'hydrated'] as const)(
    'returns a canonical identity and preserved public fields from a %s user without mutation',
    (kind) => {
      const storedId = { toString: () => 'user-id' };
      const source = Object.freeze({
        _id: storedId,
        id: 'stale-id',
        tenantId: 'tenant-id',
        email: 'user@example.com',
        role: 'USER',
        termsAccepted: true,
        personalization: { memories: false },
        favorites: [{ id: 'favorite' }],
        password: 'hashed-password',
        __v: 1,
        totpSecret: 'totp-secret',
        backupCodes: ['backup-code'],
        federatedTokens: { access_token: 'private-token' },
      });
      const user = kind === 'hydrated' ? { ...source, toObject: () => source } : source;

      expect(sanitizeUserForAuthResponse(user)).toEqual({
        _id: storedId,
        id: 'user-id',
        tenantId: 'tenant-id',
        email: 'user@example.com',
        role: 'USER',
        termsAccepted: true,
        personalization: { memories: false },
        favorites: [{ id: 'favorite' }],
      });
      expect(source.id).toBe('stale-id');
      expect(source.password).toBe('hashed-password');
      expect(source.federatedTokens.access_token).toBe('private-token');
    },
  );

  it('preserves an existing canonical id when no stored id is supplied', () => {
    expect(sanitizeUserForAuthResponse({ id: 'user-id', tenantId: 'tenant-id' })).toEqual({
      id: 'user-id',
      tenantId: 'tenant-id',
    });
  });
});

describe('sanitizeUserForResponse', () => {
  const publicFields = {
    _id: 'user-1',
    email: 'user@example.com',
    name: 'Test User',
    provider: 'local',
    role: 'USER',
    twoFactorEnabled: true,
  };

  it('keeps the fields a client is allowed to receive', () => {
    expect(sanitizeUserForResponse(publicFields as unknown as IUser)).toEqual(publicFields);
  });

  /** The queries behind these responses return the whole document, secrets included. */
  it('drops every field outside the allowlist', () => {
    const stored = {
      ...publicFields,
      password: 'password-hash',
      totpSecret: 'encrypted-secret',
      backupCodes: [{ codeHash: 'hash', used: false }],
      refreshToken: [{ refreshToken: 'live-session-token' }],
      federatedTokens: [{ provider: 'openid', accessToken: 'token' }],
      pendingTotpSecret: 'staged-secret',
      pendingBackupCodes: [{ codeHash: 'staged', used: false }],
      twoFactorAcknowledgementNonceHash: 'ack-hash',
      twoFactorFinalizationNonceHash: 'final-hash',
      twoFactorEnrolledAt: new Date(),
      __v: 0,
    };

    expect(sanitizeUserForResponse(stored as unknown as IUser)).toEqual(publicFields);
  });

  /** A field added to the schema later must stay out until it is named here deliberately. */
  it('drops a field the allowlist has never heard of', () => {
    const stored = { ...publicFields, someFieldAddedLater: 'sensitive' };

    expect(sanitizeUserForResponse(stored as unknown as IUser)).not.toHaveProperty(
      'someFieldAddedLater',
    );
  });

  it('reads through a hydrated document', () => {
    const hydrated = {
      toObject: () => ({ ...publicFields, password: 'password-hash' }),
    };

    expect(sanitizeUserForResponse(hydrated)).toEqual(publicFields);
  });

  it('omits allowlisted fields the document does not carry', () => {
    const sanitized = sanitizeUserForResponse({ _id: 'user-1' } as unknown as IUser);

    expect(sanitized).toEqual({ _id: 'user-1' });
    expect(sanitized).not.toHaveProperty('email');
  });

  it('returns an empty object for a missing user', () => {
    expect(sanitizeUserForResponse(null)).toEqual({});
    expect(sanitizeUserForResponse(undefined)).toEqual({});
  });

  it('never names a credential field in the allowlist', () => {
    for (const field of ['password', 'totpSecret', 'backupCodes', 'refreshToken']) {
      expect(PUBLIC_USER_RESPONSE_FIELDS).not.toContain(field);
    }
  });
});
