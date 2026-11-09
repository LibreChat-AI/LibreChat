import { createBitbucketPullRequestSource, isSameCommit, summarizeStatuses } from './bitbucket';

const API = 'https://api.bitbucket.org/2.0/repositories/w/r/';
const sha = 'a'.repeat(40);
const short = sha.slice(0, 12);
const newer = 'b'.repeat(12);
const pullRequest = (overrides: Record<string, unknown> = {}) => ({
  id: 7,
  title: 'Simplify single tool',
  state: 'OPEN',
  draft: false,
  links: { html: { href: 'https://bitbucket.org/w/r/pull-requests/7' } },
  source: {
    branch: { name: 'feat/x' },
    commit: { hash: short },
    repository: { full_name: 'W/R' },
  },
  ...overrides,
});
const fork = (hash = short) => ({
  branch: { name: 'feat/x' },
  commit: { hash },
  repository: { full_name: 'someone/r' },
});
const page = (values: unknown[], next?: string) => ({ values, ...(next ? { next } : {}) });
const listed = (overrides: Record<string, unknown> = {}) => page([pullRequest(overrides)]);
const status = (state: string, hash = sha) => ({ state, key: state, commit: { hash } });
const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

function sourceFor(routes: Record<string, () => Response>) {
  const fetchFn = jest.fn(async (input: string, _init?: RequestInit) => {
    const url = String(input);
    /** The most specific fragment wins, so a page link can be routed apart from its first page. */
    const key = Object.keys(routes)
      .filter((fragment) => url.includes(fragment))
      .sort((a, b) => b.length - a.length)[0];
    if (key == null) throw new Error(`unexpected ${url}`);
    return routes[key]();
  });
  return { fetchFn, source: createBitbucketPullRequestSource({ fetchFn }) };
}

const routes = (detail = pullRequest(), overrides: Record<string, () => Response> = {}) => ({
  'state=OPEN': () => json(listed()),
  'state=MERGED': () => json(page([])),
  '/pullrequests/7/diffstat': () => json(page([{ lines_added: 12, lines_removed: 3 }])),
  '/pullrequests/7/statuses': () => json(page([status('SUCCESSFUL')])),
  '/pullrequests/7': () => json(detail),
  ...overrides,
});

const find = (
  source: ReturnType<typeof createBitbucketPullRequestSource>,
  input: Record<string, unknown> = {},
) => source.find({ repo: 'w/r', branch: 'feat/x', token: 't', ...input });

const urlsOf = (fetchFn: ReturnType<typeof sourceFor>['fetchFn']) =>
  fetchFn.mock.calls.map(([url]) => String(url));

describe('summarizeStatuses', () => {
  it.each([
    [[], false, 'none'],
    [['SUCCESSFUL'], false, 'passing'],
    [['SUCCESSFUL', 'INPROGRESS'], false, 'running'],
    [['INPROGRESS', 'FAILED'], false, 'failing'],
    [['SUCCESSFUL', 'STOPPED'], false, 'failing'],
    [['SUCCESSFUL'], true, 'running'],
    [[], true, 'running'],
  ])('reports %p (incomplete %p) as %s', (states, incomplete, expected) => {
    expect(summarizeStatuses(states, incomplete)).toBe(expected);
  });
});

describe('isSameCommit', () => {
  it('compares by the shorter hash, never by fewer than seven characters', () => {
    expect(isSameCommit(sha, short)).toBe(true);
    expect(isSameCommit(short, sha)).toBe(true);
    expect(isSameCommit(sha, newer)).toBe(false);
    expect(isSameCommit(sha, 'aaaaaa')).toBe(false);
  });
});

describe('createBitbucketPullRequestSource', () => {
  it('maps an open pull request with passing statuses', async () => {
    const { source } = sourceFor(routes());
    await expect(find(source)).resolves.toEqual({
      number: 7,
      title: 'Simplify single tool',
      url: 'https://bitbucket.org/w/r/pull-requests/7',
      provider: 'bitbucket',
      additions: 12,
      deletions: 3,
      state: 'open',
      isDraft: false,
      mergeable: 'unknown',
      checks: 'passing',
    });
  });

  it('asks the repository on the API host only, with a bearer token', async () => {
    const { source, fetchFn } = sourceFor(routes());
    await find(source);
    const urls = urlsOf(fetchFn);
    expect(urls.length).toBeGreaterThan(0);
    expect(urls.every((url) => url.startsWith(API))).toBe(true);
    for (const [, init] of fetchFn.mock.calls) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer t');
      expect(headers.Accept).toBe('application/json');
    }
  });

  it('lists open pull requests first, newest first, then the closed history', async () => {
    const { source, fetchFn } = sourceFor(
      routes(pullRequest({ state: 'MERGED' }), {
        'state=OPEN': () => json(page([])),
        'state=MERGED': () => json(listed({ state: 'MERGED' })),
      }),
    );
    await find(source);
    const [open, closed] = urlsOf(fetchFn).map((url) => new URL(url).searchParams);
    expect(open.get('q')).toBe('source.branch.name = "feat/x" AND (state = "OPEN")');
    expect(open.getAll('state')).toEqual(['OPEN']);
    expect(open.get('sort')).toBe('-created_on');
    expect(open.get('pagelen')).toBe('10');
    expect(closed.get('q')).toBe(
      'source.branch.name = "feat/x" AND (state = "MERGED" OR state = "DECLINED" OR state = "SUPERSEDED")',
    );
    expect(closed.getAll('state')).toEqual(['MERGED', 'DECLINED', 'SUPERSEDED']);
    /** A full page even without a recorded commit, so a closed fork cannot hide the rest. */
    expect(closed.get('pagelen')).toBe('10');
  });

  it('finds an older closed pull request behind a newer closed fork on the same branch', async () => {
    const merged = pullRequest({ id: 3, state: 'MERGED' });
    const { source } = sourceFor(
      routes(merged, {
        'state=OPEN': () => json(page([])),
        'state=MERGED': () =>
          json(page([pullRequest({ id: 8, state: 'DECLINED', source: fork() }), merged])),
        '/pullrequests/3/diffstat': () => json(page([])),
        '/pullrequests/3/statuses': () => json(page([])),
        '/pullrequests/3': () => json(merged),
      }),
    );
    await expect(find(source)).resolves.toMatchObject({ number: 3, state: 'merged' });
  });

  describe('closed history across pages', () => {
    const merged = pullRequest({ id: 3, state: 'MERGED' });
    const declinedFork = pullRequest({ id: 8, state: 'DECLINED', source: fork() });
    const history = (next: string) =>
      routes(merged, {
        'state=OPEN': () => json(page([])),
        /** A short first page that still links on: only a missing `next` ends the list. */
        'state=MERGED': () => json(page([declinedFork], next)),
        'cursor=opaque': () => json(page([merged])),
        '/pullrequests/3/diffstat': () => json(page([])),
        '/pullrequests/3/statuses': () => json(page([])),
        '/pullrequests/3': () => json(merged),
      });

    it('follows the next link Bitbucket returns instead of building page numbers', async () => {
      const { source, fetchFn } = sourceFor(history(`${API}pullrequests?cursor=opaque`));
      await expect(find(source, { limits: { maxCandidatePages: 2 } })).resolves.toMatchObject({
        number: 3,
        state: 'merged',
      });
      expect(urlsOf(fetchFn)).toContain(`${API}pullrequests?cursor=opaque`);
      expect(urlsOf(fetchFn).some((url) => /[?&]page=/.test(url))).toBe(false);
    });

    it('reads no more pages than the configured bound', async () => {
      const { source, fetchFn } = sourceFor(history(`${API}pullrequests?cursor=opaque`));
      await expect(find(source, { limits: { maxCandidatePages: 1 } })).resolves.toBeNull();
      expect(urlsOf(fetchFn)).not.toContain(`${API}pullrequests?cursor=opaque`);
    });

    it('never follows a next link off the repository API', async () => {
      const { source, fetchFn } = sourceFor(
        history('https://evil.example/2.0/repositories/w/r/pullrequests?cursor=opaque'),
      );
      await expect(find(source, { limits: { maxCandidatePages: 2 } })).rejects.toMatchObject({
        code: 'UPSTREAM_ERROR',
      });
      expect(urlsOf(fetchFn).every((url) => url.startsWith(API))).toBe(true);
    });
  });

  it('skips a pull request whose source commit is gone and keeps searching', async () => {
    const gone = pullRequest({ id: 5, source: { ...pullRequest().source, commit: null } });
    const { source } = sourceFor(
      routes(pullRequest(), { 'state=OPEN': () => json(page([gone, pullRequest()])) }),
    );
    await expect(find(source)).resolves.toMatchObject({ number: 7 });
  });

  it('finds nothing when the detail lost its source commit', async () => {
    const gone = pullRequest({ source: { ...pullRequest().source, commit: {} } });
    const { source } = sourceFor(routes(gone));
    await expect(find(source)).resolves.toBeNull();
  });

  it.each([
    ['moved to another source branch', { branch: { name: 'other' } }],
    ['moved to a fork', { repository: { full_name: 'someone/r' } }],
  ])('finds nothing when the pull request %s after it was listed', async (_case, change) => {
    const moved = pullRequest({ source: { ...pullRequest().source, ...change } });
    const { source } = sourceFor(routes(moved));
    await expect(find(source, { head: sha })).resolves.toBeNull();
  });

  it('escapes a quote and a backslash in the branch name', async () => {
    const branch = 'a"b\\c';
    const { source, fetchFn } = sourceFor({
      'state=OPEN': () => json(page([])),
      'state=MERGED': () => json(page([])),
    });
    await find(source, { branch });
    const q = new URL(urlsOf(fetchFn)[0]).searchParams.get('q');
    expect(q).toBe('source.branch.name = "a\\"b\\\\c" AND (state = "OPEN")');
    expect(urlsOf(fetchFn)[0]).not.toContain('"');
  });

  it('maps a 401 to CREDENTIAL_REJECTED, a refusal of the token itself', async () => {
    const { source } = sourceFor({ 'state=OPEN': () => new Response('', { status: 401 }) });
    await expect(find(source)).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
  });

  it.each([
    ['another host', 'https://evil.example/w/r/pull-requests/7'],
    ['plain http', 'http://bitbucket.org/w/r/pull-requests/7'],
    ['a javascript url', 'javascript:alert(1)'],
  ])('rejects %s as the pull request page', async (_label, href) => {
    const { source } = sourceFor(routes(pullRequest({ links: { html: { href } } })));
    await expect(find(source)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it.each([
    ['MERGED', 'merged'],
    ['DECLINED', 'closed'],
    ['SUPERSEDED', 'closed'],
  ])('reports a %s pull request as %s', async (state, expected) => {
    const { source } = sourceFor(
      routes(pullRequest({ state }), {
        'state=OPEN': () => json(page([])),
        'state=MERGED': () => json(listed({ state })),
      }),
    );
    await expect(find(source)).resolves.toMatchObject({ state: expected });
  });

  it('reports a draft', async () => {
    const { source } = sourceFor(routes(pullRequest({ draft: true })));
    await expect(find(source)).resolves.toMatchObject({ isDraft: true });
  });

  it.each([
    ['failing', [status('SUCCESSFUL'), status('FAILED')]],
    ['failing', [status('STOPPED')]],
    ['running', [status('SUCCESSFUL'), status('INPROGRESS')]],
    ['none', []],
  ])('reports %s statuses', async (expected, statuses) => {
    const { source } = sourceFor(
      routes(pullRequest(), { '/pullrequests/7/statuses': () => json(page(statuses)) }),
    );
    await expect(find(source)).resolves.toMatchObject({ checks: expected });
  });

  it('ignores a status reported for another commit', async () => {
    const { source } = sourceFor(
      routes(pullRequest(), {
        '/pullrequests/7/statuses': () =>
          json(page([status('SUCCESSFUL'), status('FAILED', 'c'.repeat(40))])),
      }),
    );
    await expect(find(source)).resolves.toMatchObject({ checks: 'passing' });
  });

  it('never reports statuses past the page bound as passing', async () => {
    const { source } = sourceFor(
      routes(pullRequest(), {
        '/pullrequests/7/statuses': () =>
          json(page([status('SUCCESSFUL')], `${API}pullrequests/7/statuses?page=2`)),
      }),
    );
    await expect(find(source, { limits: { maxCheckRunPages: 1 } })).resolves.toMatchObject({
      checks: 'running',
    });
  });

  it('sums the diffstat across pages', async () => {
    const { source } = sourceFor(
      routes(pullRequest(), {
        '/pullrequests/7/diffstat?page=2': () =>
          json(
            page([
              { lines_added: 5, lines_removed: 1 },
              { lines_added: 1, lines_removed: null },
            ]),
          ),
        '/pullrequests/7/diffstat': () =>
          json(
            page([{ lines_added: 12, lines_removed: 3 }], `${API}pullrequests/7/diffstat?page=2`),
          ),
      }),
    );
    await expect(find(source)).resolves.toMatchObject({ additions: 18, deletions: 4 });
  });

  it.each([
    ['another host', 'https://evil.example/2.0/repositories/w/r/pullrequests/7/diffstat?page=2'],
    ['plain http', 'http://api.bitbucket.org/2.0/repositories/w/r/pullrequests/7/diffstat?page=2'],
    ['the site', 'https://bitbucket.org/2.0/repositories/w/r/pullrequests/7/diffstat?page=2'],
  ])('never follows a next link to %s', async (_label, next) => {
    const { source, fetchFn } = sourceFor(
      routes(pullRequest(), {
        '/pullrequests/7/diffstat': () => json(page([{ lines_added: 1, lines_removed: 1 }], next)),
      }),
    );
    await expect(find(source)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(urlsOf(fetchFn).every((url) => url.startsWith(API))).toBe(true);
  });

  it('finds nothing for a repository the token cannot see', async () => {
    const { source } = sourceFor({ 'state=OPEN': () => new Response('', { status: 404 }) });
    await expect(find(source)).resolves.toBeNull();
  });

  it('reports a rate limit with the wait Bitbucket asked for', async () => {
    const { source } = sourceFor({
      'state=OPEN': () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
    });
    await expect(find(source)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 30_000,
    });
  });

  it('fails without upstream text on any other error', async () => {
    const { source } = sourceFor({
      'state=OPEN': () => new Response('secret', { status: 500 }),
    });
    const error = await find(source).catch((caught: Error) => caught);
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it('fails on a malformed pull request', async () => {
    const { source } = sourceFor(routes(pullRequest({ source: { commit: { hash: 'zz' } } })));
    await expect(find(source)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it('finds nothing for a lane that has a branch but no commit yet', async () => {
    const { source, fetchFn } = sourceFor(routes());
    await expect(find(source, { head: null })).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('finds nothing for an empty branch', async () => {
    const { source, fetchFn } = sourceFor(routes());
    await expect(find(source, { branch: '' })).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(['w', 'w/sub/r', 'w/..', './r', 'w/r?x', 'w/r%2F', ''])(
    'asks nothing for the path %p',
    async (repo) => {
      const { source, fetchFn } = sourceFor(routes());
      await expect(find(source, { repo })).resolves.toBeNull();
      expect(fetchFn).not.toHaveBeenCalled();
    },
  );

  describe('with a recorded commit', () => {
    it('accepts a head that is the recorded commit, abbreviated', async () => {
      const { source, fetchFn } = sourceFor(routes());
      await expect(find(source, { head: sha })).resolves.toMatchObject({ number: 7 });
      expect(urlsOf(fetchFn).some((url) => url.includes('merge-base'))).toBe(false);
    });

    it('accepts a head that builds on the recorded commit', async () => {
      const newerPull = pullRequest({
        source: { ...pullRequest().source, commit: { hash: newer } },
      });
      const { source, fetchFn } = sourceFor(
        routes(newerPull, {
          'state=OPEN': () => json(page([newerPull])),
          '/pullrequests/7/statuses': () => json(page([status('SUCCESSFUL', newer)])),
          '/merge-base/': () => json({ hash: sha }),
        }),
      );
      await expect(find(source, { head: sha })).resolves.toMatchObject({
        number: 7,
        checks: 'passing',
      });
      expect(urlsOf(fetchFn)).toContain(`${API}merge-base/${sha}..${newer}`);
    });

    it('rejects a head that does not contain the recorded commit', async () => {
      const newerPull = pullRequest({
        source: { ...pullRequest().source, commit: { hash: newer } },
      });
      const { source } = sourceFor(
        routes(newerPull, {
          'state=OPEN': () => json(page([newerPull])),
          '/merge-base/': () => json({ hash: 'c'.repeat(40) }),
        }),
      );
      await expect(find(source, { head: sha })).resolves.toBeNull();
    });

    it.each([404, 400])('treats a merge base answered %s as no match', async (code) => {
      const newerPull = pullRequest({
        source: { ...pullRequest().source, commit: { hash: newer } },
      });
      const { source } = sourceFor(
        routes(newerPull, {
          'state=OPEN': () => json(page([newerPull])),
          '/merge-base/': () => new Response('', { status: code }),
        }),
      );
      await expect(find(source, { head: sha })).resolves.toBeNull();
    });

    it('stops comparing once the configured budget is spent', async () => {
      const candidates = [1, 2, 3].map((id) =>
        pullRequest({ id, source: { ...pullRequest().source, commit: { hash: newer } } }),
      );
      const { source, fetchFn } = sourceFor(
        routes(pullRequest(), {
          'state=OPEN': () => json(page(candidates)),
          '/merge-base/': () => json({ hash: 'c'.repeat(40) }),
        }),
      );
      await find(source, { head: sha, limits: { maxHeadComparisons: 2 } });
      const comparisons = urlsOf(fetchFn).filter((url) => url.includes('merge-base'));
      expect(comparisons).toHaveLength(2);
    });
  });

  describe('forks', () => {
    it('never takes a fork on its branch name alone', async () => {
      const { source } = sourceFor(
        routes(pullRequest({ source: fork() }), {
          'state=OPEN': () => json(listed({ source: fork() })),
        }),
      );
      await expect(find(source)).resolves.toBeNull();
    });

    it('never takes a pull request whose source repository is gone', async () => {
      const gone = { ...fork(), repository: null };
      const { source } = sourceFor(
        routes(pullRequest({ source: gone }), {
          'state=OPEN': () => json(listed({ source: gone })),
        }),
      );
      await expect(find(source)).resolves.toBeNull();
    });

    it('takes a fork that carries the recorded commit', async () => {
      const { source } = sourceFor(
        routes(pullRequest({ source: fork() }), {
          'state=OPEN': () => json(listed({ source: fork() })),
        }),
      );
      await expect(find(source, { head: sha })).resolves.toMatchObject({ number: 7 });
    });
  });

  describe('a linked pull request', () => {
    it('is read directly when its source branch is the lane branch', async () => {
      const { source, fetchFn } = sourceFor(routes());
      await expect(find(source, { pullRequest: 7 })).resolves.toMatchObject({ number: 7 });
      expect(urlsOf(fetchFn).some((url) => url.includes('/pullrequests?'))).toBe(false);
    });

    it('is ignored without a source commit, and the branch is searched instead', async () => {
      const gone = pullRequest({ id: 9, source: { ...pullRequest().source, commit: null } });
      const { source } = sourceFor(routes(pullRequest(), { '/pullrequests/9': () => json(gone) }));
      await expect(find(source, { pullRequest: 9 })).resolves.toMatchObject({ number: 7 });
    });

    it('is ignored for another branch, and the branch is searched instead', async () => {
      const other = pullRequest({
        id: 9,
        source: { ...pullRequest().source, branch: { name: 'other' } },
      });
      const { source, fetchFn } = sourceFor(
        routes(pullRequest(), { '/pullrequests/9': () => json(other) }),
      );
      await expect(find(source, { pullRequest: 9 })).resolves.toMatchObject({ number: 7 });
      expect(urlsOf(fetchFn).some((url) => url.includes('state=OPEN'))).toBe(true);
    });

    it('from a fork counts only with the recorded commit', async () => {
      const linked = pullRequest({ source: fork() });
      const { source } = sourceFor(routes(linked, { 'state=OPEN': () => json(page([])) }));
      await expect(find(source, { pullRequest: 7 })).resolves.toBeNull();
      await expect(find(source, { pullRequest: 7, head: sha })).resolves.toMatchObject({
        number: 7,
      });
    });
  });
});
