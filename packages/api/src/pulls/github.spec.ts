import { createGitHubPullRequestSource, summarizeChecks } from './github';
import { PullRequestSourceError } from './types';

const sha = 'a'.repeat(40);
const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 7,
  title: 'Simplify single tool',
  html_url: 'https://github.com/o/r/pull/7',
  state: 'open',
  merged: false,
  draft: false,
  additions: 12,
  deletions: 3,
  mergeable: true,
  head: { sha },
  ...overrides,
});
const listed = (state = 'open') => [{ number: 7, state, head: { sha } }];
const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

function sourceFor(routes: Record<string, () => Response>) {
  const fetchFn = jest.fn(async (input: string) => {
    const url = String(input);
    const key = Object.keys(routes).find((fragment) => url.includes(fragment));
    /** Unless a test says otherwise, no pull request carries the recorded commit. */
    if (key == null && /\/commits\/[a-f0-9]+\/pulls\?/.test(url)) return json([]);
    if (key == null) throw new Error(`unexpected ${url}`);
    return routes[key]();
  });
  return { fetchFn, source: createGitHubPullRequestSource({ fetchFn }) };
}

const find = (source: ReturnType<typeof createGitHubPullRequestSource>) =>
  source.find({ repo: 'o/r', branch: 'feat/x', token: 't' });

describe('summarizeChecks', () => {
  it.each([
    ['none', []],
    ['passing', [{ status: 'completed', conclusion: 'success' }]],
    ['passing', [{ status: 'completed', conclusion: 'skipped' }]],
    ['running', [{ status: 'in_progress', conclusion: null }]],
    ['failing', [{ status: 'completed', conclusion: 'failure' }]],
    [
      'failing',
      [
        { status: 'in_progress', conclusion: null },
        { status: 'completed', conclusion: 'timed_out' },
      ],
    ],
  ])('reports %s', (expected, runs) => {
    expect(summarizeChecks(runs)).toBe(expected);
  });
});

describe('createGitHubPullRequestSource', () => {
  const routes = (pullBody = pull(), checks: unknown = { check_runs: [] }) => ({
    '/pulls?state=open': () => json(listed()),
    '/pulls/7': () => json(pullBody),
    '/check-runs': () => json(checks),
  });

  it('maps an open, mergeable pull request with passing checks', async () => {
    const { source } = sourceFor(
      routes(pull(), { check_runs: [{ status: 'completed', conclusion: 'success' }] }),
    );
    await expect(find(source)).resolves.toEqual({
      number: 7,
      title: 'Simplify single tool',
      url: 'https://github.com/o/r/pull/7',
      additions: 12,
      deletions: 3,
      state: 'open',
      isDraft: false,
      mergeable: 'clean',
      checks: 'passing',
    });
  });

  it('reports conflicts only while the pull request is open', async () => {
    const open = sourceFor(routes(pull({ mergeable: false })));
    await expect(find(open.source)).resolves.toMatchObject({ mergeable: 'conflicting' });
    const merged = sourceFor(routes(pull({ state: 'closed', merged: true, mergeable: false })));
    await expect(find(merged.source)).resolves.toMatchObject({
      state: 'merged',
      mergeable: 'unknown',
    });
  });

  it('keeps mergeable unknown while GitHub is still computing it', async () => {
    const { source } = sourceFor(routes(pull({ mergeable: null })));
    await expect(find(source)).resolves.toMatchObject({ mergeable: 'unknown' });
  });

  it('carries draft state', async () => {
    const { source } = sourceFor(routes(pull({ draft: true })));
    await expect(find(source)).resolves.toMatchObject({ isDraft: true });
  });

  it('asks for the open pull request first, so closed history cannot hide it', async () => {
    const { source, fetchFn } = sourceFor({
      '/pulls?state=open': () => json(listed()),
      '/pulls/7': () => json(pull()),
      '/check-runs': () => json({ check_runs: [] }),
    });
    await expect(find(source)).resolves.toMatchObject({ number: 7 });
    const urls = fetchFn.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain('state=open');
    expect(urls.some((url) => url.includes('state=closed'))).toBe(false);
  });

  it('falls back to the most recently updated closed pull request when none is open', async () => {
    const { source } = sourceFor({
      '/pulls?state=open': () => json([]),
      '/pulls?state=closed': () => json([{ number: 9, state: 'closed', head: { sha } }]),
      '/pulls/9': () => json(pull({ number: 9, state: 'closed', merged: true })),
      '/check-runs': () => json({ check_runs: [] }),
    });
    await expect(find(source)).resolves.toMatchObject({ number: 9, state: 'merged' });
  });

  it('returns null when the branch has no pull request or the repository is not visible', async () => {
    const none = sourceFor({
      '/pulls?state=open': () => json([]),
      '/pulls?state=closed': () => json([]),
    });
    await expect(find(none.source)).resolves.toBeNull();
    const hidden = sourceFor({ '/pulls?state=open': () => new Response('', { status: 404 }) });
    await expect(find(hidden.source)).resolves.toBeNull();
    expect(hidden.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('queries only a plain owner/name and never contacts GitHub otherwise', async () => {
    const { source, fetchFn } = sourceFor({});
    await expect(source.find({ repo: 'o/r', branch: '', token: 't' })).resolves.toBeNull();
    for (const repo of ['../x', 'o/..', './x', 'o/.', 'a b/c', 'o', 'o/r/extra']) {
      await expect(source.find({ repo, branch: 'main', token: 't' })).resolves.toBeNull();
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('encodes the branch in the head filter', async () => {
    const { source, fetchFn } = sourceFor({
      '/pulls?state=open': () => json([]),
      '/pulls?state=closed': () => json([]),
    });
    await source.find({ repo: 'o/r', branch: 'feat/a&b=c', token: 't' });
    const url = String(fetchFn.mock.calls[0][0]);
    expect(url).toContain('head=o%3Afeat%2Fa%26b%3Dc');
  });

  it.each([
    ['a 429', new Response('', { status: 429 })],
    [
      'a 403 with no quota left',
      new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }),
    ],
  ])('maps %s to RATE_LIMITED', async (_label, response) => {
    const { source } = sourceFor({ '/pulls?state=open': () => response });
    await expect(find(source)).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it.each([
    ['a 500', () => new Response('boom', { status: 500 })],
    ['a plain 403', () => new Response('', { status: 403 })],
    ['a malformed list', () => json({ not: 'a list' })],
  ])('maps %s to UPSTREAM_ERROR', async (_label, respond) => {
    const { source } = sourceFor({ '/pulls?state=open': respond });
    await expect(find(source)).rejects.toBeInstanceOf(PullRequestSourceError);
    await expect(find(source)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('maps a network failure to UPSTREAM_ERROR without keeping its text', async () => {
    const source = createGitHubPullRequestSource({
      fetchFn: jest.fn().mockRejectedValue(new Error('connect ECONNREFUSED token=secret')),
    });
    const error = await find(source).catch((caught: Error) => caught);
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it.each([
    ['a non-github host', 'https://evil.example/o/r/pull/7'],
    ['a javascript url', 'javascript:alert(1)'],
    ['plain http', 'http://github.com/o/r/pull/7'],
  ])('rejects %s as the pull request page', async (_label, html_url) => {
    const { source } = sourceFor(routes(pull({ html_url })));
    await expect(find(source)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('bounds the title', async () => {
    const { source } = sourceFor(routes(pull({ title: 'x'.repeat(1000) })));
    const result = await find(source);
    expect(result?.title).toHaveLength(256);
  });
});

describe('check runs across pages', () => {
  const run = (conclusion: string | null, status = 'completed') => ({ status, conclusion });
  const passing = (count: number) => Array.from({ length: count }, () => run('success'));

  function sourceWithPages(pages: unknown[][], totalCount: number) {
    const fetchFn = jest.fn(async (input: string) => {
      const url = String(input);
      if (url.includes('/pulls?state=open')) return json(listed());
      if (url.includes('/pulls/7')) return json(pull());
      if (url.includes('/check-runs')) {
        const page = Number(new URL(url).searchParams.get('page') ?? '1');
        return json({ total_count: totalCount, check_runs: pages[page - 1] ?? [] });
      }
      throw new Error(`unexpected ${url}`);
    });
    return { fetchFn, source: createGitHubPullRequestSource({ fetchFn }) };
  }

  it('reads every page, so a failure past the first hundred still turns the rollup red', async () => {
    const { source } = sourceWithPages([passing(100), [run('failure')]], 101);
    await expect(find(source)).resolves.toMatchObject({ checks: 'failing' });
  });

  it('reads every page, so a check still running past the first hundred is not called passing', async () => {
    const { source } = sourceWithPages([passing(100), [run(null, 'in_progress')]], 101);
    await expect(find(source)).resolves.toMatchObject({ checks: 'running' });
  });

  it('stops after a bounded number of pages and never calls an incomplete rollup passing', async () => {
    const pages = Array.from({ length: 60 }, () => passing(100));
    const { source, fetchFn } = sourceWithPages(pages, 6000);
    await expect(find(source)).resolves.toMatchObject({ checks: 'running' });
    const checkCalls = fetchFn.mock.calls.filter(([url]) => String(url).includes('/check-runs'));
    expect(checkCalls.length).toBeLessThanOrEqual(10);
  });

  it('makes one request when every check run fits on the first page', async () => {
    const { source, fetchFn } = sourceWithPages([passing(3)], 3);
    await expect(find(source)).resolves.toMatchObject({ checks: 'passing' });
    const checkCalls = fetchFn.mock.calls.filter(([url]) => String(url).includes('/check-runs'));
    expect(checkCalls).toHaveLength(1);
  });
});

describe('rate limit back-off hint', () => {
  it('carries retry-after as milliseconds', async () => {
    const { source } = sourceFor({
      '/pulls?state=open': () =>
        new Response('', { status: 429, headers: { 'retry-after': '30' } }),
    });
    await expect(find(source)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 30_000,
    });
  });

  it('derives the wait from the quota reset when there is no retry-after', async () => {
    const reset = Math.floor(Date.now() / 1000) + 120;
    const { source } = sourceFor({
      '/pulls?state=open': () =>
        new Response('', {
          status: 403,
          headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) },
        }),
    });
    const error = (await find(source).catch((caught: unknown) => caught)) as {
      code: string;
      retryAfterMs?: number;
    };
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterMs).toBeGreaterThan(100_000);
    expect(error.retryAfterMs).toBeLessThanOrEqual(120_000);
  });

  it('leaves the hint out when GitHub gives none', async () => {
    const { source } = sourceFor({ '/pulls?state=open': () => new Response('', { status: 429 }) });
    const error = (await find(source).catch((caught: unknown) => caught)) as {
      retryAfterMs?: number;
    };
    expect(error.retryAfterMs).toBeUndefined();
  });
});

describe('lookup bounds', () => {
  const run = (conclusion: string | null, status = 'completed') => ({ status, conclusion });
  const everyRoute = (url: string, checks: () => Response) => {
    if (url.includes('/pulls?state=open')) return json(listed());
    if (url.includes('/pulls/7')) return json(pull());
    if (url.includes('/check-runs')) return checks();
    throw new Error(`unexpected ${url}`);
  };
  const aborts = (init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    });

  it('stops reading check runs at the configured page limit and calls the rollup incomplete', async () => {
    const fetchFn = jest.fn(async (url: string) =>
      everyRoute(url, () =>
        json({ total_count: 6000, check_runs: Array.from({ length: 100 }, () => run('success')) }),
      ),
    );
    const source = createGitHubPullRequestSource({ fetchFn });
    const result = await source.find({
      repo: 'o/r',
      branch: 'feat/x',
      token: 't',
      limits: { maxCheckRunPages: 2 },
    });
    expect(result).toMatchObject({ checks: 'running' });
    expect(fetchFn.mock.calls.filter(([url]) => String(url).includes('/check-runs'))).toHaveLength(
      2,
    );
  });

  it('gives up on one request that outlives the configured request timeout', async () => {
    const fetchFn = jest.fn((_url: string, init?: RequestInit) => aborts(init));
    const source = createGitHubPullRequestSource({ fetchFn });
    const started = Date.now();
    await expect(
      source.find({
        repo: 'o/r',
        branch: 'feat/x',
        token: 't',
        limits: { requestTimeoutMs: 20, lookupTimeoutMs: 5_000 },
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it('bounds the whole lookup, not only each request', async () => {
    let calls = 0;
    const fetchFn = jest.fn((url: string, init?: RequestInit) => {
      calls += 1;
      if (calls === 1 && url.includes('/pulls?state=open')) return Promise.resolve(json(listed()));
      return aborts(init);
    });
    const source = createGitHubPullRequestSource({ fetchFn });
    const started = Date.now();
    await expect(
      source.find({
        repo: 'o/r',
        branch: 'feat/x',
        token: 't',
        limits: { requestTimeoutMs: 10_000, lookupTimeoutMs: 30 },
      }),
    ).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("keeps today's defaults when no limits are given", async () => {
    const seen: Array<AbortSignal | null | undefined> = [];
    const fetchFn = jest.fn(async (url: string, init?: RequestInit) => {
      seen.push(init?.signal);
      return everyRoute(url, () => json({ total_count: 0, check_runs: [] }));
    });
    const source = createGitHubPullRequestSource({ fetchFn });
    await expect(find(source)).resolves.toMatchObject({ number: 7 });
    expect(seen.every((signal) => signal != null && !signal.aborted)).toBe(true);
  });
});

describe('matching the recorded head', () => {
  const recorded = 'c'.repeat(40);
  const compare = (status: string) => () => json({ status });
  const findWith = (
    source: ReturnType<typeof createGitHubPullRequestSource>,
    head?: string | null,
  ) => source.find({ repo: 'o/r', branch: 'feat/x', head, token: 't' });

  const routes = (status: string) => ({
    '/pulls?state=open': () => json(listed()),
    '/compare/': compare(status),
    '/pulls/7': () => json(pull()),
    '/check-runs': () => json({ total_count: 0, check_runs: [] }),
  });

  it('accepts the pull request whose head is the recorded commit, without a comparison', async () => {
    const { source, fetchFn } = sourceFor({
      '/pulls?state=open': () => json([{ number: 7, state: 'open', head: { sha: recorded } }]),
      '/pulls/7': () => json(pull({ head: { sha: recorded } })),
      '/check-runs': () => json({ total_count: 0, check_runs: [] }),
    });
    await expect(findWith(source, recorded)).resolves.toMatchObject({ number: 7 });
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/compare/'))).toBe(false);
  });

  it.each(['ahead', 'identical'])(
    'accepts a pull request that is, or builds on, the recorded commit (%s)',
    async (status) => {
      const { source } = sourceFor(routes(status));
      await expect(findWith(source, recorded)).resolves.toMatchObject({ number: 7 });
    },
  );

  it('rejects a pull request whose head is older than the recorded commit (behind)', async () => {
    const { source } = sourceFor({ ...routes('behind'), '/pulls?state=closed': () => json([]) });
    await expect(findWith(source, recorded)).resolves.toBeNull();
  });

  it('asks GitHub to compare the recorded commit to the candidate, in that order', async () => {
    const { source, fetchFn } = sourceFor(routes('ahead'));
    await findWith(source, recorded);
    const url = String(
      fetchFn.mock.calls.map(([u]) => String(u)).find((u) => u.includes('/compare/')),
    );
    expect(url).toContain(`/compare/${recorded}...${sha}`);
  });

  it('rejects a pull request whose commits diverged from the recorded head', async () => {
    const { source } = sourceFor({ ...routes('diverged'), '/pulls?state=closed': () => json([]) });
    await expect(findWith(source, recorded)).resolves.toBeNull();
  });

  it('treats a recorded commit GitHub no longer knows as no match', async () => {
    const { source } = sourceFor({
      ...routes('ahead'),
      '/compare/': () => new Response('', { status: 404 }),
      '/pulls?state=closed': () => json([]),
    });
    await expect(findWith(source, recorded)).resolves.toBeNull();
  });

  it('falls back to a closed pull request that matches when the open one does not', async () => {
    const { source } = sourceFor({
      '/pulls?state=open': () => json([{ number: 9, state: 'open', head: { sha } }]),
      '/pulls?state=closed': () => json([{ number: 7, state: 'closed', head: { sha: recorded } }]),
      '/compare/': compare('diverged'),
      '/pulls/7': () => json(pull({ state: 'closed', merged: true, head: { sha: recorded } })),
      '/check-runs': () => json({ total_count: 0, check_runs: [] }),
    });
    await expect(findWith(source, recorded)).resolves.toMatchObject({
      number: 7,
      state: 'merged',
    });
  });

  it('compares as many candidates as configured, no more', async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      number: index + 1,
      state: 'open',
      head: { sha },
    }));
    const { source, fetchFn } = sourceFor({
      '/pulls?state=open': () => json(many),
      '/pulls?state=closed': () => json(many),
      '/compare/': compare('diverged'),
    });
    await expect(
      source.find({
        repo: 'o/r',
        branch: 'feat/x',
        head: recorded,
        token: 't',
        limits: { maxHeadComparisons: 5 },
      }),
    ).resolves.toBeNull();
    expect(fetchFn.mock.calls.filter(([u]) => String(u).includes('/compare/'))).toHaveLength(5);
  });

  it('lists as many candidate pull requests as configured', async () => {
    const { source, fetchFn } = sourceFor({
      '/pulls?state=open': () => json([]),
      '/pulls?state=closed': () => json([]),
    });
    await source.find({
      repo: 'o/r',
      branch: 'feat/x',
      head: recorded,
      token: 't',
      limits: { maxCandidatePullRequests: 40 },
    });
    const urls = fetchFn.mock.calls.map(([u]) => String(u));
    expect(urls.every((u) => u.includes('per_page=40'))).toBe(true);
  });

  it('limits how many candidates it compares', async () => {
    const many = Array.from({ length: 10 }, (_, index) => ({
      number: index + 1,
      state: 'open',
      head: { sha },
    }));
    const { source, fetchFn } = sourceFor({
      '/pulls?state=open': () => json(many),
      '/pulls?state=closed': () => json(many),
      '/compare/': compare('diverged'),
    });
    await expect(findWith(source, recorded)).resolves.toBeNull();
    const compares = fetchFn.mock.calls.filter(([url]) => String(url).includes('/compare/'));
    expect(compares.length).toBeLessThanOrEqual(3);
  });

  it.each([null, undefined])('does not compare when no head was recorded (%s)', async (head) => {
    const { source, fetchFn } = sourceFor(routes('diverged'));
    await expect(findWith(source, head)).resolves.toMatchObject({ number: 7 });
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/compare/'))).toBe(false);
  });

  it('ignores a recorded head that is not a commit id rather than putting it in a path', async () => {
    const { source, fetchFn } = sourceFor(routes('diverged'));
    await expect(findWith(source, '../../etc')).resolves.toMatchObject({ number: 7 });
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/compare/'))).toBe(false);
  });
});

describe('check runs follow the current head of the pull request', () => {
  const newer = 'd'.repeat(40);

  it('reads checks for the head the detail reports, not the one the list saw', async () => {
    const { source, fetchFn } = sourceFor({
      '/pulls?state=open': () => json(listed()),
      '/pulls/7': () => json(pull({ head: { sha: newer } })),
      '/check-runs': () => json({ total_count: 0, check_runs: [] }),
    });
    await expect(find(source)).resolves.toMatchObject({ number: 7 });
    const urls = fetchFn.mock.calls.map(([url]) => String(url));
    expect(urls.some((url) => url.includes(`/commits/${newer}/check-runs`))).toBe(true);
    expect(urls.some((url) => url.includes(`/commits/${sha}/check-runs`))).toBe(false);
  });

  it('reads the detail before the checks, so they describe the same commit', async () => {
    const { source, fetchFn } = sourceFor({
      '/pulls?state=open': () => json(listed()),
      '/pulls/7': () => json(pull()),
      '/check-runs': () => json({ total_count: 0, check_runs: [] }),
    });
    await find(source);
    const urls = fetchFn.mock.calls.map(([url]) => String(url));
    expect(urls.findIndex((url) => url.includes('/pulls/7'))).toBeLessThan(
      urls.findIndex((url) => url.includes('/check-runs')),
    );
  });

  it.each([
    ['a missing head', { head: undefined }],
    ['a head without a sha', { head: {} }],
    ['a head that is not a commit id', { head: { sha: '../../x' } }],
  ])('rejects a pull request detail with %s', async (_label, overrides) => {
    const { source, fetchFn } = sourceFor({
      '/pulls?state=open': () => json(listed()),
      '/pulls/7': () => json(pull(overrides)),
      '/check-runs': () => json({ total_count: 0, check_runs: [] }),
    });
    await expect(find(source)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/check-runs'))).toBe(false);
  });
});

describe('a head that moves after the candidate was listed', () => {
  const recorded = 'c'.repeat(40);
  const moved = 'd'.repeat(40);
  const base = {
    '/pulls?state=open': () => json([{ number: 7, state: 'open', head: { sha: recorded } }]),
    '/check-runs': () => json({ total_count: 0, check_runs: [] }),
  };
  const run = (source: ReturnType<typeof createGitHubPullRequestSource>) =>
    source.find({ repo: 'o/r', branch: 'feat/x', head: recorded, token: 't' });

  it('returns nothing when the detail head no longer contains the recorded commit', async () => {
    const { source } = sourceFor({
      ...base,
      '/compare/': () => json({ status: 'diverged' }),
      '/pulls/7': () => json(pull({ head: { sha: moved } })),
    });
    await expect(run(source)).resolves.toBeNull();
  });

  it('keeps the pull request when the moved head still builds on the recorded commit', async () => {
    const { source, fetchFn } = sourceFor({
      ...base,
      '/compare/': () => json({ status: 'ahead' }),
      '/pulls/7': () => json(pull({ head: { sha: moved } })),
    });
    await expect(run(source)).resolves.toMatchObject({ number: 7 });
    expect(
      fetchFn.mock.calls.some(([url]) => String(url).includes(`/commits/${moved}/check-runs`)),
    ).toBe(true);
  });

  it('spends the comparison budget on the moved head too, and stops when it is spent', async () => {
    const { source, fetchFn } = sourceFor({
      ...base,
      '/compare/': () => json({ status: 'ahead' }),
      '/pulls/7': () => json(pull({ head: { sha: moved } })),
    });
    await expect(
      source.find({
        repo: 'o/r',
        branch: 'feat/x',
        head: recorded,
        token: 't',
        limits: { maxHeadComparisons: 0 },
      }),
    ).resolves.toBeNull();
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/compare/'))).toBe(false);
  });

  it('does not compare again when the detail head is the one that matched', async () => {
    const { source, fetchFn } = sourceFor({
      ...base,
      '/pulls/7': () => json(pull({ head: { sha: recorded } })),
    });
    await expect(run(source)).resolves.toMatchObject({ number: 7 });
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/compare/'))).toBe(false);
  });
});

describe('a pull request whose head is in a fork', () => {
  const recorded = 'c'.repeat(40);
  const forked = (overrides: Record<string, unknown> = {}) => ({
    number: 12,
    state: 'open',
    head: { sha: recorded, ref: 'feat/x' },
    ...overrides,
  });
  const routes = (found: unknown[], status = 200) => ({
    '/pulls?state=open': () => json([]),
    '/pulls?state=closed': () => json([]),
    '/pulls?per_page': () => json(found, { status }),
    '/pulls/12': () => json(pull({ number: 12, head: { sha: recorded } })),
  });
  const run = (source: ReturnType<typeof createGitHubPullRequestSource>) =>
    source.find({ repo: 'o/r', branch: 'feat/x', head: recorded, token: 't' });

  it('finds it through the recorded commit when the owner-scoped lists are empty', async () => {
    const { source, fetchFn } = sourceFor({
      ...routes([forked()]),
      '/check-runs': () => json({ total_count: 0, check_runs: [] }),
    });
    await expect(run(source)).resolves.toMatchObject({ number: 12 });
    expect(
      fetchFn.mock.calls.some(([url]) => String(url).includes(`/commits/${recorded}/pulls`)),
    ).toBe(true);
  });

  it('ignores a pull request for the commit that is on another branch', async () => {
    const { source } = sourceFor(routes([forked({ head: { sha: recorded, ref: 'other' } })]));
    await expect(run(source)).resolves.toBeNull();
  });

  it('treats a commit GitHub does not know as no pull request', async () => {
    const { source } = sourceFor(routes([], 422));
    await expect(run(source)).resolves.toBeNull();
  });

  it('does not ask without a recorded commit', async () => {
    const { source, fetchFn } = sourceFor(routes([forked()]));
    await expect(source.find({ repo: 'o/r', branch: 'feat/x', token: 't' })).resolves.toBeNull();
    expect(fetchFn.mock.calls.some(([url]) => String(url).includes('/commits/'))).toBe(false);
  });
});

describe('a secondary rate limit without limiting headers', () => {
  const secondary = () =>
    new Response(
      JSON.stringify({ message: 'You have exceeded a secondary rate limit. Please wait.' }),
      { status: 403 },
    );

  it('is a rate limit that waits at least a minute', async () => {
    const { source } = sourceFor({ '/pulls?state=open': secondary });
    const error = await find(source).catch((caught) => caught);
    expect(error.code).toBe('RATE_LIMITED');
    expect(error.retryAfterMs).toBeGreaterThanOrEqual(60_000);
  });

  it('leaves an ordinary 403 as an upstream error', async () => {
    const { source } = sourceFor({
      '/pulls?state=open': () =>
        new Response(JSON.stringify({ message: 'Resource not accessible by token' }), {
          status: 403,
        }),
    });
    await expect(find(source)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('does not put the response text in the error', async () => {
    const { source } = sourceFor({ '/pulls?state=open': secondary });
    const error = await find(source).catch((caught) => caught);
    expect(JSON.stringify(error)).not.toContain('secondary rate limit');
    expect(String(error.message)).not.toContain('secondary');
  });
});
