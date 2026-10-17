import { createGitLabPullRequestSource, summarizePipeline } from './gitlab';

const sha = 'a'.repeat(40);
const newer = 'b'.repeat(40);
const mergeRequest = (overrides: Record<string, unknown> = {}) => ({
  iid: 7,
  title: 'Simplify single tool',
  web_url: 'https://gitlab.com/g/r/-/merge_requests/7',
  state: 'opened',
  draft: false,
  sha,
  source_branch: 'feat/x',
  source_project_id: 1,
  target_project_id: 1,
  detailed_merge_status: 'mergeable',
  has_conflicts: false,
  head_pipeline: { status: 'success', sha },
  ...overrides,
});
const listed = (overrides: Record<string, unknown> = {}) => [
  { iid: 7, state: 'opened', sha, source_project_id: 1, target_project_id: 1, ...overrides },
];
const stats = (additions = 12, deletions = 3) => ({
  data: { project: { mergeRequest: { diffStatsSummary: { additions, deletions } } } },
});
const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

function sourceFor(routes: Record<string, () => Response>) {
  const fetchFn = jest.fn(async (input: string, _init?: RequestInit) => {
    const url = String(input);
    const key = Object.keys(routes).find((fragment) => url.includes(fragment));
    /** Nothing is being merged unless a test says so. */
    if (key == null && url.includes('state=locked')) return json([]);
    if (key == null) throw new Error(`unexpected ${url}`);
    return routes[key]();
  });
  return { fetchFn, source: createGitLabPullRequestSource({ fetchFn }) };
}

const routes = (detail = mergeRequest(), overrides: Record<string, () => Response> = {}) => ({
  'state=opened': () => json(listed()),
  'state=merged': () => json([]),
  'state=closed': () => json([]),
  '/merge_requests/7': () => json(detail),
  '/api/graphql': () => json(stats()),
  ...overrides,
});

const find = (
  source: ReturnType<typeof createGitLabPullRequestSource>,
  input: Record<string, unknown> = {},
) => source.find({ repo: 'g/r', branch: 'feat/x', token: 't', ...input });

describe('summarizePipeline', () => {
  it.each([
    [null, 'none'],
    ['success', 'passing'],
    ['skipped', 'passing'],
    ['failed', 'failing'],
    ['canceled', 'failing'],
    ['running', 'running'],
    ['pending', 'running'],
    ['manual', 'running'],
  ])('reports %s as %s', (status, expected) => {
    expect(summarizePipeline(status)).toBe(expected);
  });
});

describe('createGitLabPullRequestSource', () => {
  it('maps an open, mergeable merge request with a passing pipeline', async () => {
    const { source } = sourceFor(routes());
    await expect(find(source)).resolves.toEqual({
      number: 7,
      title: 'Simplify single tool',
      url: 'https://gitlab.com/g/r/-/merge_requests/7',
      provider: 'gitlab',
      additions: 12,
      deletions: 3,
      state: 'open',
      isDraft: false,
      mergeable: 'clean',
      checks: 'passing',
    });
  });

  it('asks the project by its encoded path, with a bearer token, and nowhere else', async () => {
    const { source, fetchFn } = sourceFor(routes());
    await find(source);
    const urls = fetchFn.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain('https://gitlab.com/api/v4/projects/g%2Fr/merge_requests?');
    expect(urls.every((url) => url.startsWith('https://gitlab.com/api/'))).toBe(true);
    const init = fetchFn.mock.calls[0][1] ?? {};
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer t');
  });

  it('reads a nested group project on a self-managed host', async () => {
    const host = 'gitlab.example.com';
    const { source, fetchFn } = sourceFor(
      routes(mergeRequest({ web_url: `https://${host}/g/sub/r/-/merge_requests/7` })),
    );
    const result = await find(source, { repo: 'g/sub/r', host });
    expect(result?.url).toBe(`https://${host}/g/sub/r/-/merge_requests/7`);
    const urls = fetchFn.mock.calls.map(([url]) => String(url));
    expect(urls[0]).toContain(`https://${host}/api/v4/projects/g%2Fsub%2Fr/`);
    expect(urls.every((url) => url.startsWith(`https://${host}/api/`))).toBe(true);
  });

  it('maps a 401 to CREDENTIAL_REJECTED, a refusal of the token itself', async () => {
    const { source } = sourceFor({ 'state=opened': () => new Response('', { status: 401 }) });
    await expect(find(source)).rejects.toMatchObject({ code: 'CREDENTIAL_REJECTED' });
  });

  it.each([
    ['another host', 'https://evil.example/g/r/-/merge_requests/7'],
    ['plain http', 'http://gitlab.com/g/r/-/merge_requests/7'],
    ['a javascript url', 'javascript:alert(1)'],
  ])('rejects %s as the merge request page', async (_label, web_url) => {
    const { source } = sourceFor(routes(mergeRequest({ web_url })));
    await expect(find(source)).rejects.toMatchObject({ code: 'UPSTREAM_ERROR' });
  });

  it.each([
    ['merged', 'merged'],
    ['closed', 'closed'],
    ['locked', 'closed'],
  ])('reports a %s merge request as %s, with no conflict state', async (state, expected) => {
    const { source } = sourceFor({
      'state=opened': () => json([]),
      'state=merged': () => json([]),
      'state=closed': () => json(listed({ state })),
      '/merge_requests/7': () => json(mergeRequest({ state, has_conflicts: true })),
      '/api/graphql': () => json(stats()),
    });
    await expect(find(source)).resolves.toMatchObject({ state: expected, mergeable: 'unknown' });
  });

  it('reports conflicts and drafts while open', async () => {
    const { source } = sourceFor(
      routes(mergeRequest({ has_conflicts: true, detailed_merge_status: 'conflict', draft: true })),
    );
    await expect(find(source)).resolves.toMatchObject({
      mergeable: 'conflicting',
      isDraft: true,
    });
  });

  it('ignores a pipeline that ran for an earlier head', async () => {
    const { source } = sourceFor(
      routes(mergeRequest({ head_pipeline: { status: 'failed', sha: newer } })),
    );
    await expect(find(source)).resolves.toMatchObject({ checks: 'none' });
  });

  it('reports zero lines for a merge request without changes', async () => {
    const { source } = sourceFor(
      routes(mergeRequest(), {
        '/api/graphql': () =>
          json({ data: { project: { mergeRequest: { diffStatsSummary: null } } } }),
      }),
    );
    await expect(find(source)).resolves.toMatchObject({ additions: 0, deletions: 0 });
  });

  it('fails rather than invent line counts when GraphQL reports an error', async () => {
    const { source } = sourceFor(
      routes(mergeRequest(), { '/api/graphql': () => json({ errors: [{ message: 'secret' }] }) }),
    );
    const error = await find(source).catch((caught: Error) => caught);
    expect(error).toMatchObject({ code: 'UPSTREAM_ERROR' });
    expect(String((error as Error).message)).not.toContain('secret');
  });

  it('finds nothing for a project the token cannot see', async () => {
    const { source } = sourceFor({ 'state=opened': () => new Response('', { status: 404 }) });
    await expect(find(source)).resolves.toBeNull();
  });

  it('reports a rate limit with the wait GitLab asked for', async () => {
    const { source } = sourceFor({
      'state=opened': () => new Response('', { status: 429, headers: { 'retry-after': '30' } }),
    });
    await expect(find(source)).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      retryAfterMs: 30_000,
    });
  });

  it('finds nothing for a lane that has a branch but no commit yet', async () => {
    const { source, fetchFn } = sourceFor(routes());
    await expect(find(source, { head: null })).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it.each(['g', 'g/../r', 'g/./r', 'g/r?x', ''])('asks nothing for the path %p', async (repo) => {
    const { source, fetchFn } = sourceFor(routes());
    await expect(find(source, { repo })).resolves.toBeNull();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  describe('with a recorded commit', () => {
    it('accepts a head that builds on the recorded commit', async () => {
      const { source, fetchFn } = sourceFor(
        routes(mergeRequest({ sha: newer, head_pipeline: null }), {
          'state=opened': () => json(listed({ sha: newer })),
          '/repository/merge_base': () => json({ id: sha }),
        }),
      );
      await expect(find(source, { head: sha })).resolves.toMatchObject({ number: 7 });
      const compared = fetchFn.mock.calls
        .map(([url]) => String(url))
        .find((url) => url.includes('merge_base'));
      expect(compared).toContain(`refs[]=${sha}&refs[]=${newer}`);
    });

    it('rejects a head that does not contain the recorded commit', async () => {
      const { source } = sourceFor(
        routes(mergeRequest({ sha: newer }), {
          'state=opened': () => json(listed({ sha: newer })),
          '/repository/merge_base': () => json({ id: 'c'.repeat(40) }),
        }),
      );
      await expect(find(source, { head: sha })).resolves.toBeNull();
    });

    it('treats a commit GitLab does not know as no match', async () => {
      const { source } = sourceFor(
        routes(mergeRequest({ sha: newer }), {
          'state=opened': () => json(listed({ sha: newer })),
          '/repository/merge_base': () => new Response('', { status: 400 }),
        }),
      );
      await expect(find(source, { head: sha })).resolves.toBeNull();
    });

    it('stops comparing once the configured budget is spent', async () => {
      const { source, fetchFn } = sourceFor(
        routes(mergeRequest({ sha: newer }), {
          'state=opened': () =>
            json([1, 2, 3].map((iid) => ({ ...listed({ sha: newer })[0], iid }))),
          '/repository/merge_base': () => json({ id: 'c'.repeat(40) }),
        }),
      );
      await find(source, { head: sha, limits: { maxHeadComparisons: 2 } });
      const comparisons = fetchFn.mock.calls.filter(([url]) => String(url).includes('merge_base'));
      expect(comparisons).toHaveLength(2);
    });
  });

  it('finds a merged merge request behind more open forks than one page holds', async () => {
    const forks = Array.from({ length: 10 }, (_, index) => ({
      iid: 20 + index,
      state: 'opened',
      sha,
      source_project_id: 2,
      target_project_id: 1,
    }));
    const merged = { iid: 7, state: 'merged', sha, source_project_id: 1, target_project_id: 1 };
    const { source, fetchFn } = sourceFor({
      'state=opened': () => json(forks),
      'state=merged': () => json([merged]),
      'state=closed': () => json([]),
      '/merge_requests/7': () => json(mergeRequest({ state: 'merged' })),
      '/api/graphql': () => json(stats()),
    });
    await expect(find(source)).resolves.toMatchObject({ number: 7, state: 'merged' });
    const history = fetchFn.mock.calls
      .map(([url]) => String(url))
      .find((url) => url.includes('state=merged'));
    expect(new URL(history ?? '').searchParams.get('per_page')).toBe('10');
  });

  it('finds a merge request while GitLab is merging it, ahead of older history', async () => {
    const item = (iid: number, state: string) => ({
      iid,
      state,
      sha,
      source_project_id: 1,
      target_project_id: 1,
    });
    const { source, fetchFn } = sourceFor({
      'state=opened': () => json([]),
      'state=locked': () => json([item(9, 'locked')]),
      'state=merged': () => json([item(3, 'merged')]),
      'state=closed': () => json([]),
      '/merge_requests/9': () => json(mergeRequest({ iid: 9, state: 'locked' })),
      '/api/graphql': () => json(stats()),
    });
    await expect(find(source)).resolves.toMatchObject({ number: 9 });
    const locked = fetchFn.mock.calls
      .map(([url]) => new URL(String(url)))
      .find((url) => url.searchParams.get('state') === 'locked');
    expect(locked?.searchParams.get('source_branch')).toBe('feat/x');
  });

  it('takes the newest of the merged and closed merge requests', async () => {
    const item = (iid: number, state: string) => ({
      iid,
      state,
      sha,
      source_project_id: 1,
      target_project_id: 1,
    });
    const { source } = sourceFor({
      'state=opened': () => json([]),
      'state=merged': () => json([item(3, 'merged')]),
      'state=closed': () => json([item(7, 'closed')]),
      '/merge_requests/7': () => json(mergeRequest({ state: 'closed' })),
      '/api/graphql': () => json(stats()),
    });
    await expect(find(source)).resolves.toMatchObject({ number: 7, state: 'closed' });
  });

  it('drops a merge request whose source branch changed after it was listed', async () => {
    const { source } = sourceFor(routes(mergeRequest({ source_branch: 'other' })));
    await expect(find(source)).resolves.toBeNull();
  });

  describe('forks', () => {
    const fork = { source_project_id: 2, target_project_id: 1 };

    it('never takes a fork on its branch name alone', async () => {
      const { source } = sourceFor(
        routes(mergeRequest(fork), { 'state=opened': () => json(listed(fork)) }),
      );
      await expect(find(source)).resolves.toBeNull();
    });

    it('takes a fork that carries the recorded commit', async () => {
      const { source } = sourceFor(
        routes(mergeRequest(fork), { 'state=opened': () => json(listed(fork)) }),
      );
      await expect(find(source, { head: sha })).resolves.toMatchObject({ number: 7 });
    });
  });

  describe('a linked merge request', () => {
    it('is read directly when its source branch is the lane branch', async () => {
      const { source, fetchFn } = sourceFor(routes());
      await expect(find(source, { pullRequest: 7 })).resolves.toMatchObject({ number: 7 });
      const urls = fetchFn.mock.calls.map(([url]) => String(url));
      expect(urls.some((url) => url.includes('/merge_requests?'))).toBe(false);
    });

    it('is ignored for another branch, and the branch is searched instead', async () => {
      const { source, fetchFn } = sourceFor(
        routes(mergeRequest(), {
          '/merge_requests/9': () => json(mergeRequest({ iid: 9, source_branch: 'other' })),
        }),
      );
      await expect(find(source, { pullRequest: 9 })).resolves.toMatchObject({ number: 7 });
      expect(fetchFn.mock.calls.some(([url]) => String(url).includes('state=opened'))).toBe(true);
    });

    it('from a fork counts only with the recorded commit', async () => {
      const fork = mergeRequest({ source_project_id: 2, target_project_id: 1 });
      const { source } = sourceFor(routes(fork, { 'state=opened': () => json([]) }));
      await expect(find(source, { pullRequest: 7 })).resolves.toBeNull();
    });
  });
});
