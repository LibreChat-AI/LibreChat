import { isTokenIssuedBeforeCredentialChange } from './credentials';

const changedAt = new Date(1700000010500);

describe('isTokenIssuedBeforeCredentialChange', () => {
  it('revokes nothing for an account that never changed credentials', () => {
    expect(isTokenIssuedBeforeCredentialChange({ iat: 1 }, {})).toBe(false);
    expect(isTokenIssuedBeforeCredentialChange({ iat: 1 }, undefined)).toBe(false);
  });

  it('rejects a token minted before the change', () => {
    expect(
      isTokenIssuedBeforeCredentialChange({ iat: 1700000009 }, { credentialsChangedAt: changedAt }),
    ).toBe(true);
  });

  it('fails closed for a token minted inside the second of the change', () => {
    expect(
      isTokenIssuedBeforeCredentialChange({ iat: 1700000010 }, { credentialsChangedAt: changedAt }),
    ).toBe(true);
  });

  it('accepts a token minted after the change', () => {
    expect(
      isTokenIssuedBeforeCredentialChange({ iat: 1700000011 }, { credentialsChangedAt: changedAt }),
    ).toBe(false);
  });

  it('reads string and numeric stamps the way Mongo or a cache may hand them back', () => {
    const user = { credentialsChangedAt: changedAt.toISOString() };
    expect(isTokenIssuedBeforeCredentialChange({ iat: 1700000009 }, user)).toBe(true);
    expect(
      isTokenIssuedBeforeCredentialChange(
        { iat: 1700000011 },
        { credentialsChangedAt: changedAt.getTime() },
      ),
    ).toBe(false);
  });

  it('rejects a token without a usable iat once credentials have changed', () => {
    const user = { credentialsChangedAt: changedAt };
    expect(isTokenIssuedBeforeCredentialChange({}, user)).toBe(true);
    expect(isTokenIssuedBeforeCredentialChange(undefined, user)).toBe(true);
    expect(isTokenIssuedBeforeCredentialChange({ iat: Number.NaN }, user)).toBe(true);
  });

  it('ignores an unreadable stamp rather than locking the account out', () => {
    expect(
      isTokenIssuedBeforeCredentialChange({ iat: 1 }, { credentialsChangedAt: 'not-a-date' }),
    ).toBe(false);
  });
});
