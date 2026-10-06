import { PULL_REQUEST_BATCH_VERSION } from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import { resolvePullRequestCapabilities } from './capabilities';

const configWith = (pullRequests?: Record<string, unknown>) =>
  ({ endpoints: { agents: pullRequests ? { pullRequests } : {} } }) as unknown as AppConfig;

describe('resolvePullRequestCapabilities', () => {
  it('advertises the flag and the batch version together when the feature is on', () => {
    expect(resolvePullRequestCapabilities(configWith({ enabled: true }))).toEqual({
      pullRequestsEnabled: true,
      pullRequestsBatchVersion: PULL_REQUEST_BATCH_VERSION,
    });
  });

  it.each([
    ['no config', undefined],
    ['a null config', null],
    ['a config without endpoints', {} as AppConfig],
    ['no pull request settings', configWith()],
    ['the feature switched off', configWith({ enabled: false })],
    ['a non-true value', configWith({ enabled: 'yes' })],
  ])('advertises neither the flag nor a version with %s', (_label, appConfig) => {
    const capabilities = resolvePullRequestCapabilities(appConfig);
    expect(capabilities).toEqual({ pullRequestsEnabled: false });
    expect(capabilities).not.toHaveProperty('pullRequestsBatchVersion');
  });
});
