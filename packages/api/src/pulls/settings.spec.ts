import {
  isPullRequestFeatureActive,
  resolvePullRequestToken,
  resolveTokenReference,
} from './settings';

describe('resolvePullRequestToken', () => {
  it('prefers the configured reference over any fallback', () => {
    expect(
      resolvePullRequestToken('${MY_TOKEN}', { MY_TOKEN: 'mine', GITHUB_TOKEN: 'other' }),
    ).toBe('mine');
  });

  it('does not fall back when the configured reference does not resolve', () => {
    expect(resolvePullRequestToken('${MY_TOKEN}', { GITHUB_TOKEN: 'other' })).toBeNull();
    expect(resolvePullRequestToken('not-a-reference', { GITHUB_TOKEN: 'other' })).toBeNull();
  });

  it.each([
    [
      'GITHUB_PULL_REQUEST_TOKEN',
      { GITHUB_PULL_REQUEST_TOKEN: 'a', GITHUB_TOKEN: 'b', GH_TOKEN: 'c' },
      'a',
    ],
    ['GITHUB_TOKEN', { GITHUB_TOKEN: ' b ', GH_TOKEN: 'c' }, 'b'],
    ['GH_TOKEN', { GH_TOKEN: 'c' }, 'c'],
  ])('falls back to %s, in that order', (_name, env, expected) => {
    expect(resolvePullRequestToken(undefined, env)).toBe(expected);
  });

  it('is null when no token exists anywhere, or only a blank one', () => {
    expect(resolvePullRequestToken(undefined, {})).toBeNull();
    expect(resolvePullRequestToken(undefined, { GITHUB_TOKEN: '  ' })).toBeNull();
  });
});

describe('resolveTokenReference', () => {
  it.each([
    ['${GH_TOKEN}', { GH_TOKEN: ' abc ' }, 'abc'],
    ['${GH_TOKEN}', {}, null],
    ['literal-token', { 'literal-token': 'x' }, null],
    [undefined, { GH_TOKEN: 'x' }, null],
  ])('resolves %s', (reference, env, expected) => {
    expect(resolveTokenReference(reference, env)).toBe(expected);
  });
});

describe('isPullRequestFeatureActive', () => {
  const env = { GITHUB_TOKEN: 't' };

  it('is on without any switch once there is a token and a list of repositories', () => {
    expect(isPullRequestFeatureActive({ allowedRepositories: ['o/r'] }, env)).toBe(true);
  });

  it('is on with the opt-in to every repository, and no list', () => {
    expect(isPullRequestFeatureActive({ allowAllRepositories: true }, env)).toBe(true);
  });

  it('stays dormant without a repository scope, so a worker cannot name its own', () => {
    expect(isPullRequestFeatureActive({}, env)).toBe(false);
    expect(isPullRequestFeatureActive(undefined, env)).toBe(false);
    expect(isPullRequestFeatureActive({ allowedRepositories: [] }, env)).toBe(false);
    expect(isPullRequestFeatureActive({ allowAllRepositories: false }, env)).toBe(false);
  });

  it('stays dormant without any token', () => {
    expect(isPullRequestFeatureActive({ allowAllRepositories: true }, {})).toBe(false);
  });

  it('counts a configured reference as a token even before it resolves, so the failure is visible', () => {
    expect(
      isPullRequestFeatureActive({ token: '${MISSING}', allowAllRepositories: true }, {}),
    ).toBe(true);
  });

  it('is off when an administrator turns it off, whatever else is set', () => {
    expect(isPullRequestFeatureActive({ enabled: false, allowAllRepositories: true }, env)).toBe(
      false,
    );
  });

  it('is on when explicitly enabled and fully scoped', () => {
    expect(isPullRequestFeatureActive({ enabled: true, allowAllRepositories: true }, env)).toBe(
      true,
    );
  });
});
