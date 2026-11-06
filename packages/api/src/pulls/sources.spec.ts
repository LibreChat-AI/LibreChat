import type { PullRequestSource } from './types';
import { createPullRequestSource, routePullRequestSources } from './sources';

const input = { repo: 'o/r', branch: 'feat/x', token: 't' };

describe('routePullRequestSources', () => {
  const github: PullRequestSource = { find: jest.fn().mockResolvedValue(null) };
  const gitlab: PullRequestSource = { find: jest.fn().mockResolvedValue(null) };
  const bitbucket: PullRequestSource = { find: jest.fn().mockResolvedValue(null) };
  const source = routePullRequestSources({ github, gitlab, bitbucket });

  beforeEach(() => jest.clearAllMocks());

  it('asks GitHub when no provider is named, as before providers existed', async () => {
    await source.find(input);
    expect(github.find).toHaveBeenCalledWith(input);
    expect(gitlab.find).not.toHaveBeenCalled();
  });

  it('asks the named provider and no other', async () => {
    await source.find({ ...input, provider: 'gitlab' });
    expect(gitlab.find).toHaveBeenCalledTimes(1);
    expect(github.find).not.toHaveBeenCalled();
    await source.find({ ...input, provider: 'bitbucket' });
    expect(bitbucket.find).toHaveBeenCalledTimes(1);
    expect(gitlab.find).toHaveBeenCalledTimes(1);
  });

  it('reports a provider without a source as not configured', async () => {
    const githubOnly = routePullRequestSources({ github });
    await expect(githubOnly.find({ ...input, provider: 'gitlab' })).rejects.toMatchObject({
      code: 'NOT_CONFIGURED',
    });
  });
});

describe('createPullRequestSource', () => {
  it('routes Bitbucket to Bitbucket Cloud', async () => {
    const fetchFn = jest.fn(async (_input: string, _init?: RequestInit) =>
      Response.json({ values: [] }),
    );
    const source = createPullRequestSource({ fetchFn });
    await expect(source.find({ ...input, provider: 'bitbucket' })).resolves.toBeNull();
    expect(String(fetchFn.mock.calls[0][0])).toMatch(
      /^https:\/\/api\.bitbucket\.org\/2\.0\/repositories\/o\/r\/pullrequests\?/,
    );
  });
});
