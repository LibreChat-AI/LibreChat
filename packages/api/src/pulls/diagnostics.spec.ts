import { logger } from '@librechat/data-schemas';
import { createBitbucketPullRequestSource } from './bitbucket';
import { createGitHubPullRequestSource } from './github';
import { createGitLabPullRequestSource } from './gitlab';
import { createPullRequestLookup } from './lookup';
import { PullRequestSourceError } from './types';

const recorded = 'a'.repeat(40);
const candidate = 'b'.repeat(40);
const input = {
  repo: 'o/r',
  branch: 'private-branch',
  head: recorded,
  token: 'secret-token',
  ttlMs: 30_000,
};

describe('pull request discovery diagnostics', () => {
  let debug: jest.SpyInstance;

  beforeEach(() => {
    debug = jest.spyOn(logger, 'debug').mockImplementation();
  });
  afterAll(() => debug.mockRestore());

  it.each(['CREDENTIAL_REJECTED', 'RATE_LIMITED', 'UPSTREAM_ERROR'] as const)(
    'logs a safe reason for %s without changing the lookup result',
    async (code) => {
      const lookup = createPullRequestLookup({
        source: { find: jest.fn().mockRejectedValue(new PullRequestSourceError(code)) },
      });
      await expect(lookup(input)).resolves.toEqual({ ok: false, error: { code } });
      expect(debug).toHaveBeenCalledWith('[PullRequests] Discovery diagnostic', {
        provider: 'github',
        reason: code,
      });
    },
  );

  it('does not log raw unexpected exceptions or lookup identity', async () => {
    const lookup = createPullRequestLookup({
      source: { find: jest.fn().mockRejectedValue(new Error('secret-provider-payload')) },
    });
    await lookup(input);
    expect(debug.mock.calls).toEqual([
      ['[PullRequests] Discovery diagnostic', { provider: 'github', reason: 'UPSTREAM_ERROR' }],
    ]);
  });

  it('does not log a cached failure again', async () => {
    const lookup = createPullRequestLookup({
      source: {
        find: jest.fn().mockRejectedValue(new PullRequestSourceError('CREDENTIAL_REJECTED')),
      },
    });
    await lookup(input);
    await lookup(input);
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['github', createGitHubPullRequestSource],
    ['gitlab', createGitLabPullRequestSource],
    ['bitbucket', createBitbucketPullRequestSource],
  ] as const)('%s explains an inconclusive ancestry check', async (provider, create) => {
    const fetchFn = jest.fn(async (url: string) => {
      if (
        url.includes('/compare/') ||
        url.includes('/merge_base?') ||
        url.includes('/merge-base/')
      ) {
        return new Response(null, { status: 404 });
      }
      if (url.includes('state=open&')) {
        return Response.json([{ number: 7, state: 'open', head: { sha: candidate } }]);
      }
      if (url.includes('state=opened')) {
        return Response.json([
          { iid: 7, state: 'opened', sha: candidate, source_project_id: 1, target_project_id: 1 },
        ]);
      }
      if (url.includes('state=OPEN')) {
        return Response.json({
          values: [
            {
              id: 7,
              state: 'OPEN',
              source: {
                branch: { name: input.branch },
                commit: { hash: candidate },
                repository: { full_name: input.repo },
              },
            },
          ],
        });
      }
      return Response.json(provider === 'bitbucket' ? { values: [] } : []);
    });
    await expect(create({ fetchFn }).find(input)).resolves.toBeNull();
    expect(debug).toHaveBeenCalledWith('[PullRequests] Discovery diagnostic', {
      provider,
      reason: 'COMPARISON_UNAVAILABLE',
    });
  });

  it.each([
    ['github', createGitHubPullRequestSource],
    ['gitlab', createGitLabPullRequestSource],
    ['bitbucket', createBitbucketPullRequestSource],
  ] as const)('%s explains an exhausted comparison budget', async (provider, create) => {
    const fetchFn = jest.fn(async (url: string) => {
      if (url.includes('state=open&')) {
        return Response.json([{ number: 7, state: 'open', head: { sha: candidate } }]);
      }
      if (url.includes('state=opened')) {
        return Response.json([
          { iid: 7, state: 'opened', sha: candidate, source_project_id: 1, target_project_id: 1 },
        ]);
      }
      if (url.includes('state=OPEN')) {
        return Response.json({
          values: [
            {
              id: 7,
              state: 'OPEN',
              source: {
                branch: { name: input.branch },
                commit: { hash: candidate },
                repository: { full_name: input.repo },
              },
            },
          ],
        });
      }
      return Response.json(provider === 'bitbucket' ? { values: [] } : []);
    });
    await expect(
      create({ fetchFn }).find({
        ...input,
        limits: { maxHeadComparisons: 0 },
      }),
    ).resolves.toBeNull();
    expect(debug).toHaveBeenCalledWith('[PullRequests] Discovery diagnostic', {
      provider,
      reason: 'COMPARISON_LIMIT',
    });
  });
});
