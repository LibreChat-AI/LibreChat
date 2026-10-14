import {
  resolvePullRequestOAuth,
  resolveTokenReference,
  resolvePullRequestHost,
  resolvePullRequestToken,
  isPullRequestFeatureActive,
  resolvePullRequestRecording,
  resolvePullRequestProvider,
} from './settings';

describe('resolvePullRequestOAuth', () => {
  const oauth = { clientId: '${ID}', clientSecret: '${SECRET}' };
  const env = { ID: 'client', SECRET: 'secret' };

  it('resolves the app on the provider host', () => {
    expect(
      resolvePullRequestOAuth({ provider: 'gitlab', host: 'GitLab.Example.com', oauth }, env),
    ).toEqual({
      provider: 'gitlab',
      host: 'gitlab.example.com',
      clientId: 'client',
      clientSecret: 'secret',
    });
    expect(resolvePullRequestOAuth({ oauth: { ...oauth, scope: ' repo ' } }, env)).toMatchObject({
      provider: 'github',
      host: 'github.com',
      scope: 'repo',
    });
  });

  it('is null without an app, or when a reference does not resolve', () => {
    expect(resolvePullRequestOAuth({}, env)).toBeNull();
    expect(resolvePullRequestOAuth({ oauth }, { ID: 'client' })).toBeNull();
    expect(resolvePullRequestOAuth({ oauth: { ...oauth, clientId: 'literal' } }, env)).toBeNull();
  });

  it('turns the feature on without a server token or a repository list', () => {
    expect(isPullRequestFeatureActive({ oauth }, env)).toBe(true);
    expect(isPullRequestFeatureActive({ oauth, enabled: false }, env)).toBe(false);
  });
});

describe('resolvePullRequestProvider', () => {
  it('is GitHub when none is configured', () => {
    expect(resolvePullRequestProvider(undefined)).toBe('github');
  });

  it.each(['github', 'gitlab', 'bitbucket'])('accepts %s', (provider) => {
    expect(resolvePullRequestProvider(provider)).toBe(provider);
  });

  it('refuses a provider this server does not know', () => {
    expect(resolvePullRequestProvider('gitea')).toBeNull();
  });
});

describe('resolvePullRequestHost', () => {
  it('is github.com when no host is configured', () => {
    expect(resolvePullRequestHost(undefined)).toBe('github.com');
  });

  it('normalizes a configured host, which the raw YAML does not', () => {
    expect(resolvePullRequestHost('  GitHub.Example.com ')).toBe('github.example.com');
    expect(resolvePullRequestHost('ghe.local:8443')).toBe('ghe.local:8443');
    expect(resolvePullRequestHost('ghe.local:08443')).toBe('ghe.local:8443');
  });

  it('drops the https default port, which a page URL never carries', () => {
    expect(resolvePullRequestHost('github.com:443')).toBe('github.com');
    expect(resolvePullRequestHost('GHE.Example.com:443')).toBe('ghe.example.com');
  });

  it.each([
    'https://github.example.com',
    'github.example.com/api',
    'u@github.example.com',
    'ghe.local:0',
    'ghe.local:65536',
    'ghe.local:99999',
    '',
  ])('refuses %p rather than falling back to github.com', (host) => {
    expect(resolvePullRequestHost(host)).toBeNull();
  });

  it("defaults to the provider's own host", () => {
    expect(resolvePullRequestHost(undefined, 'gitlab')).toBe('gitlab.com');
    expect(resolvePullRequestHost(undefined, 'bitbucket')).toBe('bitbucket.org');
    expect(resolvePullRequestHost('GitLab.Example.com', 'gitlab')).toBe('gitlab.example.com');
  });

  it('refuses any Bitbucket host but Cloud, which is all this server can read', () => {
    expect(resolvePullRequestHost('bitbucket.example.com', 'bitbucket')).toBeNull();
    expect(resolvePullRequestHost('Bitbucket.org', 'bitbucket')).toBe('bitbucket.org');
  });
});

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

  it('falls back to the variables of the configured provider only', () => {
    const gitlab = { provider: 'gitlab' as const, allowAllRepositories: true };
    expect(isPullRequestFeatureActive(gitlab, { GITHUB_TOKEN: 't' })).toBe(false);
    expect(isPullRequestFeatureActive(gitlab, { GITLAB_TOKEN: 't' })).toBe(true);
    expect(resolvePullRequestToken(undefined, { GITLAB_TOKEN: 'g', GH_TOKEN: 'h' }, 'gitlab')).toBe(
      'g',
    );
    expect(
      resolvePullRequestToken(undefined, { BITBUCKET_PULL_REQUEST_TOKEN: 'b' }, 'bitbucket'),
    ).toBe('b');
  });

  it('stays dormant for a provider this server does not know', () => {
    expect(
      isPullRequestFeatureActive(
        { provider: 'gitea' as never, token: '${T}', allowAllRepositories: true },
        env,
      ),
    ).toBe(false);
  });

  it('stays dormant with a host that is not a host name, so the token goes nowhere', () => {
    expect(
      isPullRequestFeatureActive(
        { host: 'https://ghe.example.com', allowAllRepositories: true },
        env,
      ),
    ).toBe(false);
    expect(
      isPullRequestFeatureActive({ host: 'ghe.example.com', allowAllRepositories: true }, env),
    ).toBe(true);
  });

  it('is on when explicitly enabled and fully scoped', () => {
    expect(isPullRequestFeatureActive({ enabled: true, allowAllRepositories: true }, env)).toBe(
      true,
    );
  });
});

describe('resolvePullRequestRecording', () => {
  const env = { GITHUB_TOKEN: 't' };
  it('records with the configured host when the feature is on', () => {
    expect(
      resolvePullRequestRecording({ host: 'GHE.example.com:443', allowAllRepositories: true }, env),
    ).toEqual({ enabled: true, host: 'ghe.example.com' });
    expect(resolvePullRequestRecording({ allowAllRepositories: true }, env)).toEqual({
      enabled: true,
      host: 'github.com',
    });
  });

  it('records links on the default host of the configured provider', () => {
    expect(
      resolvePullRequestRecording(
        { provider: 'gitlab', allowAllRepositories: true },
        { GITLAB_TOKEN: 't' },
      ),
    ).toEqual({ enabled: true, host: 'gitlab.com' });
  });

  it('records nothing when the feature is off', () => {
    expect(resolvePullRequestRecording({ allowAllRepositories: true }, {})).toEqual({
      enabled: false,
    });
  });
});
