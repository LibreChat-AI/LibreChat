import type { TConversationPullRequest } from 'librechat-data-provider';
import type { PullRequestSource } from './types';
import { createPullRequestLookup } from './lookup';
import { PullRequestSourceError } from './types';

const value: TConversationPullRequest = {
  number: 1,
  title: 't',
  url: 'https://github.com/o/r/pull/1',
  additions: 1,
  deletions: 0,
  state: 'open',
  isDraft: false,
  mergeable: 'clean',
  checks: 'passing',
};
const input = { repo: 'o/r', branch: 'main', token: 't', ttlMs: 30_000 };

describe('createPullRequestLookup', () => {
  it('reuses a result within its lifetime and asks again after it', async () => {
    let clock = 0;
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, now: () => clock });
    await expect(lookup(input)).resolves.toEqual({ ok: true, value });
    clock = 29_999;
    await lookup(input);
    expect(find).toHaveBeenCalledTimes(1);
    clock = 30_001;
    await lookup(input);
    expect(find).toHaveBeenCalledTimes(2);
  });

  it('caches a documented absence', async () => {
    const find = jest.fn().mockResolvedValue(null);
    const lookup = createPullRequestLookup({ source: { find } });
    await expect(lookup(input)).resolves.toEqual({ ok: true, value: null });
    await lookup(input);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('shares one request between concurrent callers', async () => {
    let release: (pr: TConversationPullRequest) => void = () => undefined;
    const find = jest.fn(
      () =>
        new Promise<TConversationPullRequest>((resolve) => {
          release = resolve;
        }),
    );
    const lookup = createPullRequestLookup({ source: { find } });
    const first = lookup(input);
    const second = lookup(input);
    release(value);
    await expect(Promise.all([first, second])).resolves.toEqual([
      { ok: true, value },
      { ok: true, value },
    ]);
    expect(find).toHaveBeenCalledTimes(1);
  });

  it('keys by repository and branch', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find } });
    await lookup(input);
    await lookup({ ...input, branch: 'other' });
    await lookup({ ...input, repo: 'o/other' });
    expect(find).toHaveBeenCalledTimes(3);
  });

  it('returns a failure as a coded result and retries it sooner than a success', async () => {
    let clock = 0;
    const find = jest
      .fn()
      .mockRejectedValueOnce(new PullRequestSourceError('RATE_LIMITED'))
      .mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, now: () => clock });
    await expect(lookup(input)).resolves.toEqual({
      ok: false,
      error: { code: 'RATE_LIMITED' },
    });
    clock = 5_000;
    await expect(lookup(input)).resolves.toMatchObject({ ok: false });
    expect(find).toHaveBeenCalledTimes(1);
    clock = 10_001;
    await expect(lookup(input)).resolves.toEqual({ ok: true, value });
  });

  it('turns an unexpected exception into UPSTREAM_ERROR without its text', async () => {
    const source: PullRequestSource = {
      find: jest.fn().mockRejectedValue(new Error('mongodb://user:secret@host')),
    };
    const result = await createPullRequestLookup({ source })(input);
    expect(result).toEqual({ ok: false, error: { code: 'UPSTREAM_ERROR' } });
    expect(JSON.stringify(result)).not.toContain('secret');
  });

  it('evicts the oldest entry past its bound', async () => {
    const find = jest.fn().mockResolvedValue(value);
    const lookup = createPullRequestLookup({ source: { find }, maxEntries: 2 });
    await lookup({ ...input, branch: 'a' });
    await lookup({ ...input, branch: 'b' });
    await lookup({ ...input, branch: 'c' });
    await lookup({ ...input, branch: 'a' });
    expect(find).toHaveBeenCalledTimes(4);
  });
});
