import {
  extractProviderSessionRef,
  mergeProviderSessionRef,
  hashProviderSessionId,
  isProviderSessionRef,
  isSameProviderSessionRef,
  providerSessionCredentialExpiry,
} from './ref';

describe('extractProviderSessionRef', () => {
  const identity = { issuer: 'https://idp.example.com', clientId: 'librechat' };

  it('extracts and normalizes the issuer when sid is a non-empty string', () => {
    expect(
      extractProviderSessionRef(
        { sid: 'session-1' },
        {
          issuer: 'https://idp.example.com/.well-known/openid-configuration',
          clientId: 'librechat',
        },
      ),
    ).toEqual({ issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'session-1' });
  });

  it('returns null when claims are absent', () => {
    expect(extractProviderSessionRef(undefined, identity)).toBeNull();
    expect(extractProviderSessionRef(null, identity)).toBeNull();
  });

  it.each([undefined, null, '', 42, {}])('returns null for a non-string sid: %p', (sid) => {
    expect(extractProviderSessionRef({ sid }, identity)).toBeNull();
  });

  it('returns null when the issuer cannot be normalized', () => {
    expect(
      extractProviderSessionRef({ sid: 'session-1' }, { issuer: undefined, clientId: 'librechat' }),
    ).toBeNull();
    expect(
      extractProviderSessionRef({ sid: 'session-1' }, { issuer: '   ', clientId: 'librechat' }),
    ).toBeNull();
  });

  it('keys the ref on the concrete tenant issuer when the configured issuer is a {tenantid} template the claims match', () => {
    const templateIssuer = 'https://login.microsoftonline.com/{tenantid}/v2.0';
    const tenantIssuer =
      'https://login.microsoftonline.com/11111111-2222-3333-4444-555555555555/v2.0';
    expect(
      extractProviderSessionRef(
        { sid: 'session-1', iss: tenantIssuer },
        { issuer: templateIssuer, clientId: 'librechat' },
      ),
    ).toEqual({ issuer: tenantIssuer, clientId: 'librechat', sid: 'session-1' });
  });

  it('falls back to the configured template issuer when the claims carry no matching iss', () => {
    const templateIssuer = 'https://login.microsoftonline.com/{tenantid}/v2.0';
    expect(
      extractProviderSessionRef(
        { sid: 'session-1' },
        { issuer: templateIssuer, clientId: 'librechat' },
      ),
    ).toEqual({ issuer: templateIssuer, clientId: 'librechat', sid: 'session-1' });
  });
});

describe('mergeProviderSessionRef', () => {
  const ref = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'session-1' };
  const other = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'session-2' };

  it('keeps the bound ref when the refreshed claims carry none', () => {
    expect(mergeProviderSessionRef(ref, null)).toEqual({ ok: true, ref });
  });

  it('keeps the bound ref when the refreshed one is identical', () => {
    expect(mergeProviderSessionRef(ref, { ...ref })).toEqual({ ok: true, ref });
  });

  it('does not adopt a ref renewal cannot establish on its own', () => {
    expect(mergeProviderSessionRef(null, ref)).toEqual({ ok: true, ref: null });
  });

  it('reports a conflict instead of silently replacing a different bound ref', () => {
    expect(mergeProviderSessionRef(ref, other)).toEqual({ ok: false, code: 'CONFLICT' });
  });

  it('keeps null bound to null when nothing refreshed', () => {
    expect(mergeProviderSessionRef(null, null)).toEqual({ ok: true, ref: null });
  });
});

describe('hashProviderSessionId', () => {
  it('returns a 12-character hex fingerprint', () => {
    const hash = hashProviderSessionId('session-1');
    expect(hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it('is deterministic and distinguishes different sids', () => {
    expect(hashProviderSessionId('session-1')).toBe(hashProviderSessionId('session-1'));
    expect(hashProviderSessionId('session-1')).not.toBe(hashProviderSessionId('session-2'));
  });
});

describe('isProviderSessionRef', () => {
  const ref = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'session-1' };

  it('accepts a well-formed ref', () => {
    expect(isProviderSessionRef(ref)).toBe(true);
  });

  it.each([null, undefined, {}, { issuer: 'x' }, { ...ref, sid: 42 }, 'nope'])(
    'rejects %p',
    (value) => {
      expect(isProviderSessionRef(value)).toBe(false);
    },
  );
});

describe('isSameProviderSessionRef', () => {
  const ref = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'session-1' };
  const other = { issuer: 'https://idp.example.com', clientId: 'librechat', sid: 'session-2' };

  it('is true only when both refs are non-null and every field matches', () => {
    expect(isSameProviderSessionRef(ref, { ...ref })).toBe(true);
  });

  it('is false when the refs differ', () => {
    expect(isSameProviderSessionRef(ref, other)).toBe(false);
  });

  it('is false when either side is null or undefined', () => {
    expect(isSameProviderSessionRef(null, ref)).toBe(false);
    expect(isSameProviderSessionRef(ref, undefined)).toBe(false);
    expect(isSameProviderSessionRef(null, null)).toBe(false);
  });
});

describe('providerSessionCredentialExpiry', () => {
  it('returns now plus the longest given lifetime', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(providerSessionCredentialExpiry(now, 1000, 5000, 2000).getTime()).toBe(
      now.getTime() + 5000,
    );
  });

  it('returns now unchanged when no lifetimes are given', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    expect(providerSessionCredentialExpiry(now).getTime()).toBe(now.getTime());
  });
});
