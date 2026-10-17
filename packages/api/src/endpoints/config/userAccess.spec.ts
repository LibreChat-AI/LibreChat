import {
  filterEndpointCatalog,
  filterModelSpecsForUser,
  getUserEndpointAllowlist,
  isEndpointAllowedForUser,
} from './userAccess';

const rules = [
  { username: 'restricted-user', allowedEndpoints: ['Allowed Provider'] },
  { username: 'empty-user', allowedEndpoints: [] },
  { userId: 'user-123', allowedEndpoints: ['Allowed Provider'] },
];

describe('user endpoint access policy', () => {
  it('leaves users without a matching rule unrestricted', () => {
    expect(getUserEndpointAllowlist({ username: 'unlisted-user' }, rules)).toBeUndefined();
    expect(
      isEndpointAllowedForUser({ username: 'unlisted-user' }, 'Restricted Provider', rules),
    ).toBe(true);
    expect(isEndpointAllowedForUser(undefined, 'Restricted Provider', rules)).toBe(true);
  });

  it('matches usernames case-insensitively and normalizes endpoint names', () => {
    expect(getUserEndpointAllowlist({ username: 'RESTRICTED-USER' }, rules)).toEqual(
      new Set(['Allowed Provider']),
    );
    expect(
      isEndpointAllowedForUser({ username: 'Restricted-User' }, 'Allowed Provider', rules),
    ).toBe(true);
    expect(
      isEndpointAllowedForUser({ username: 'restricted-user' }, 'Restricted Provider', rules),
    ).toBe(false);
  });

  it('matches a stable user ID from either the request user or Mongo record', () => {
    expect(getUserEndpointAllowlist({ id: 'user-123' }, rules)).toEqual(
      new Set(['Allowed Provider']),
    );
    expect(isEndpointAllowedForUser({ _id: 'user-123' }, 'Restricted Provider', rules)).toBe(false);
    expect(
      isEndpointAllowedForUser({ _id: { toString: () => 'user-123' } }, 'Allowed Provider', rules),
    ).toBe(true);
    expect(isEndpointAllowedForUser({ id: 'another-user' }, 'Restricted Provider', rules)).toBe(
      true,
    );
  });

  it('keeps custom endpoint identities distinct when their case differs', () => {
    const caseSensitiveRules = [{ username: 'restricted-user', allowedEndpoints: ['Provider'] }];

    expect(
      isEndpointAllowedForUser({ username: 'restricted-user' }, 'Provider', caseSensitiveRules),
    ).toBe(true);
    expect(
      isEndpointAllowedForUser({ username: 'restricted-user' }, 'provider', caseSensitiveRules),
    ).toBe(false);
    expect(
      filterEndpointCatalog(
        { Provider: ['allowed-model'], provider: ['other-model'] },
        new Set(['Provider']),
      ),
    ).toEqual({ Provider: ['allowed-model'] });
  });

  it('supports an explicit empty allowlist', () => {
    expect(isEndpointAllowedForUser({ username: 'empty-user' }, 'Allowed Provider', rules)).toBe(
      false,
    );
  });

  it('filters endpoint/model catalogs using the same normalized allowlist', () => {
    expect(
      filterEndpointCatalog(
        { 'Allowed Provider': ['allowed-model'], 'Restricted Provider': ['restricted-model'] },
        getUserEndpointAllowlist({ username: 'restricted-user' }, rules),
      ),
    ).toEqual({ 'Allowed Provider': ['allowed-model'] });
    expect(filterEndpointCatalog({ 'Allowed Provider': ['allowed-model'] }, undefined)).toEqual({
      'Allowed Provider': ['allowed-model'],
    });
  });

  it('filters model specs and added provider endpoints for a restricted user', () => {
    expect(
      filterModelSpecsForUser(
        {
          list: [
            { name: 'allowed-model-spec', preset: { endpoint: 'Allowed Provider' } },
            { name: 'blocked-model-spec', preset: { endpoint: 'Restricted Provider' } },
          ],
          addedEndpoints: ['Allowed Provider', 'Restricted Provider'],
        },
        { username: 'restricted-user' },
        rules,
      ),
    ).toEqual({
      list: [{ name: 'allowed-model-spec', preset: { endpoint: 'Allowed Provider' } }],
      addedEndpoints: ['Allowed Provider'],
    });
  });
});
