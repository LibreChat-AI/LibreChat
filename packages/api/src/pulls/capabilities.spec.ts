import { PULL_REQUEST_BATCH_VERSION } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { resolvePullRequestCapabilities } from './capabilities';

const configWith = (pullRequests?: Record<string, unknown>) =>
  ({ endpoints: { agents: pullRequests ? { pullRequests } : {} } }) as unknown as AppConfig;

const env = { GITHUB_TOKEN: 't' };
const scoped = { allowAllRepositories: true };

describe('resolvePullRequestCapabilities', () => {
  it('advertises the flag, the batch version and the lookup limit together when the feature is on', () => {
    expect(resolvePullRequestCapabilities(configWith(scoped), env)).toEqual({
      pullRequestsEnabled: true,
      pullRequestsBatchVersion: PULL_REQUEST_BATCH_VERSION,
      pullRequestsMaxConcurrentLookups: 4,
    });
  });

  it('advertises the configured lookup limit', () => {
    expect(
      resolvePullRequestCapabilities(configWith({ ...scoped, maxConcurrentLookups: 2 }), env),
    ).toMatchObject({ pullRequestsMaxConcurrentLookups: 2 });
  });

  it.each([
    ['no config', undefined],
    ['a null config', null],
    ['a config without endpoints', {} as AppConfig],
    ['no pull request settings', configWith()],
    ['the feature switched off', configWith({ ...scoped, enabled: false })],
    ['no repository scope', configWith({ enabled: true })],
  ])('advertises neither the flag nor a version with %s', (_label, appConfig) => {
    const capabilities = resolvePullRequestCapabilities(appConfig, env);
    expect(capabilities).toEqual({ pullRequestsEnabled: false });
    expect(capabilities).not.toHaveProperty('pullRequestsBatchVersion');
    expect(capabilities).not.toHaveProperty('pullRequestsMaxConcurrentLookups');
  });

  it('is on by default once a token exists and a scope is set, with no enabled switch', () => {
    expect(resolvePullRequestCapabilities(configWith(scoped), env)).toMatchObject({
      pullRequestsEnabled: true,
    });
  });

  it('advertises nothing when there is no token to read with', () => {
    expect(resolvePullRequestCapabilities(configWith(scoped), {})).toEqual({
      pullRequestsEnabled: false,
    });
  });
});
