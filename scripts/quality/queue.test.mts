import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import type { API, Context, Request } from './comment.mts';

import { client, renderRequest } from './comment.mts';
import { publishGroup, publishQueueRun } from './queue.mts';

const base = 'b'.repeat(40);
const source = 'a'.repeat(40);
const other = 'f'.repeat(40);
const intermediate = 'c'.repeat(40);
const head = 'd'.repeat(40);
const context: Context = {
  repository: 'owner/repo',
  server: 'https://github.com',
  run: 55,
  attempt: 1,
};
const group = {
  base_sha: base,
  head_sha: head,
  base_ref: 'refs/heads/dev',
  head_ref: 'refs/heads/gh-readonly-queue/dev/pr-2-abc123',
};
const request = (pr: number, sha: string): Request => ({
  request: pr + 10,
  pr,
  head: sha,
  base,
  run: pr + 50,
  attempt: 1,
  actor: 'maintainer',
  phase: 'completed',
  conclusion: 'success',
  check: 'both',
  scopes: ['data-schemas'],
  staticMutants: false,
});
const comment = (value: Request) => ({
  databaseId: 100 + value.pr,
  body: renderRequest(value, context, value.head),
  author: { __typename: 'Bot', login: 'github-actions' },
});
const pull = (pr: number, sha: string) => ({
  number: pr,
  state: 'OPEN',
  baseRefName: 'dev',
  headRefOid: sha,
  comments: { pageInfo: { hasNextPage: false }, nodes: [comment(request(pr, sha))] },
});

class GitHub implements API {
  calls: { method: string; path: string }[] = [];
  statuses: { state: string; context: string; description: string }[] = [];
  ref = head;
  baseRef = base;
  queueRun = {
    event: 'merge_group',
    path: '.github/workflows/change-quality.yml',
    head_sha: head,
    head_branch: group.head_ref.slice('refs/heads/'.length),
    status: 'completed',
    conclusion: 'success',
    repository: { full_name: context.repository },
  };
  comparison = {
    status: 'ahead',
    total_commits: 4,
    merge_base_commit: { sha: base },
    commits: [
      { sha: source, parents: [{ sha: base }] },
      { sha: intermediate, parents: [{ sha: base }, { sha: source }] },
      { sha: other, parents: [{ sha: base }] },
      { sha: head, parents: [{ sha: intermediate }, { sha: other }] },
    ],
  };
  associations = [pull(2, other), pull(1, source)].map((item) => ({
    associatedPullRequests: { pageInfo: { hasNextPage: false }, nodes: [item] },
  }));
  extraComments: ReturnType<typeof comment>[] = [];
  graphQLError = false;
  async request<T>(method: string, path: string, body?: object): Promise<T> {
    this.calls.push({ method, path });
    let result: object;
    if (path.startsWith('statuses/')) {
      assert.equal(path, `statuses/${head}`);
      this.statuses.push(body as (typeof this.statuses)[number]);
      result = {};
    } else if (path.startsWith('compare/')) {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
      result = {
        ...this.comparison,
        commits: this.comparison.commits.slice((page - 1) * 100, page * 100),
      };
    } else if (path === '/graphql') {
      assert.deepEqual((body as { variables: object }).variables, { owner: 'owner', name: 'repo' });
      result = this.graphQLError
        ? { errors: [{ message: 'Unavailable' }] }
        : {
            data: {
              repository: Object.fromEntries(
                this.associations.map((value, index) => [`p${index}`, value]),
              ),
            },
          };
    } else if (path.startsWith('issues/')) {
      assert.equal(path, 'issues/1/comments?per_page=100&page=2');
      result = this.extraComments.map((item) => ({
        id: item.databaseId,
        body: item.body,
        user: { type: item.author.__typename, login: `${item.author.login}[bot]` },
      }));
    } else if (path === 'actions/runs/55') {
      result = this.queueRun;
    } else if (path === 'git/ref/heads/dev') {
      result = { object: { sha: this.baseRef } };
    } else if (path.startsWith('git/ref/')) {
      assert.equal(path, 'git/ref/heads/gh-readonly-queue/dev/pr-2-abc123');
      result = { object: { sha: this.ref } };
    } else throw new Error(`Unexpected API call: ${method} ${path}`);
    return structuredClone(result) as T;
  }
}

test('a merge group inherits successful exact-head decisions for every source PR in one batch', async () => {
  const api = new GitHub();
  await publishGroup(api, context, group);
  assert.deepEqual(
    api.statuses.map(({ state }) => state),
    ['pending', 'success'],
  );
  assert.ok(api.statuses.every((status) => status.context === 'Quality decision'));
  assert.equal(api.calls.filter(({ path }) => path === '/graphql').length, 1);
  assert.equal(api.calls.filter(({ path }) => path.startsWith('issues/')).length, 0);
});

test('explicit ignore is accepted, but missing, failed, running, stale and spoofed decisions block', async () => {
  for (const mode of ['ignore', 'missing', 'failure', 'running', 'stale', 'spoofed', 'other-pr']) {
    const api = new GitHub();
    const item = api.associations[1].associatedPullRequests.nodes[0];
    const value = request(1, source);
    if (mode === 'ignore') Object.assign(value, { check: 'ignore', scopes: [], phase: 'ignored' });
    if (mode === 'failure') value.conclusion = 'failure';
    if (mode === 'running') Object.assign(value, { phase: 'running', conclusion: null });
    if (mode === 'stale') value.head = base;
    if (mode === 'other-pr') value.pr = 99;
    item.comments.nodes = mode === 'missing' ? [] : [comment(value)];
    if (mode === 'spoofed')
      item.comments.nodes[0].author = { __typename: 'User', login: 'github-actions' };
    await publishGroup(api, context, group);
    assert.equal(api.statuses.at(-1)?.state, mode === 'ignore' ? 'success' : 'failure', mode);
  }
});

test('a later accepted request for an incorporated head supersedes an earlier success', async () => {
  const api = new GitHub();
  const newer = { ...request(1, source), request: 100, phase: 'queued', conclusion: null };
  api.associations[1].associatedPullRequests.nodes[0].comments.nodes.push(comment(newer));
  await publishGroup(api, context, group);
  assert.equal(api.statuses.at(-1)?.state, 'failure');
});

test('comparison and comment pagination preserve all merge members and decisions', async () => {
  const api = new GitHub();
  api.comparison.commits.unshift(
    ...Array.from({ length: 100 }, (_, index) => ({
      sha: index.toString(16).padStart(40, '0'),
      parents: [{ sha: base }],
    })),
  );
  api.comparison.total_commits = api.comparison.commits.length;
  const comments = api.associations[1].associatedPullRequests.nodes[0].comments;
  comments.pageInfo.hasNextPage = true;
  comments.nodes = Array.from({ length: 100 }, (_, index) => ({
    ...comment(request(1, source)),
    body: 'ordinary comment',
    databaseId: index,
  }));
  api.extraComments = [comment(request(1, source))];
  await publishGroup(api, context, group);
  assert.equal(api.statuses.at(-1)?.state, 'success');
  assert.equal(api.calls.filter(({ path }) => path.startsWith('compare/')).length, 2);
  assert.equal(api.calls.filter(({ path }) => path.startsWith('issues/')).length, 1);
});

test('unsupported, incomplete, ambiguous and superseded groups fail closed', async () => {
  const cases: ((api: GitHub) => void)[] = [
    (api) => {
      api.comparison.commits.at(-1)!.parents.pop();
    },
    (api) => {
      api.comparison.commits = api.comparison.commits.filter(({ sha }) => sha !== intermediate);
      api.comparison.total_commits--;
    },
    (api) => {
      api.comparison.total_commits++;
    },
    (api) => {
      api.comparison.total_commits = 1001;
    },
    (api) => {
      api.comparison.merge_base_commit.sha = source;
    },
    (api) => {
      api.comparison.status = 'diverged';
    },
    (api) => {
      api.comparison.commits[0].sha = intermediate;
    },
    (api) => {
      api.associations[0].associatedPullRequests.nodes = [];
    },
    (api) => {
      api.associations[0].associatedPullRequests.nodes.push(pull(3, other));
    },
    (api) => {
      api.associations[0].associatedPullRequests.pageInfo.hasNextPage = true;
    },
    (api) => {
      api.associations[0].associatedPullRequests.nodes[0].headRefOid = base;
    },
    (api) => {
      api.associations[0].associatedPullRequests.nodes[0].baseRefName = 'main';
    },
    (api) => {
      api.associations[0].associatedPullRequests.nodes[0].state = 'CLOSED';
    },
    (api) => {
      api.graphQLError = true;
    },
    (api) => {
      api.ref = source;
    },
    (api) => {
      api.baseRef = source;
    },
  ];
  for (const change of cases) {
    const api = new GitHub();
    change(api);
    await assert.rejects(publishGroup(api, context, group));
    assert.equal(api.statuses.at(-1)?.state, 'failure');
    assert.ok(!api.statuses.some(({ state }) => state === 'success'));
  }
});

test('trusted workflow completion resolves the queue and revalidates its protected base', async () => {
  const api = new GitHub();
  await publishQueueRun(api, context, 55);
  assert.equal(api.statuses.at(-1)?.state, 'success');
  assert.equal(api.calls.filter(({ path }) => path === 'git/ref/heads/dev').length, 2);
});

test('unrelated, failed, active and malformed workflow runs cannot publish queue decisions', async () => {
  for (const overrides of [
    { event: 'pull_request' },
    { path: '.github/workflows/other.yml' },
    { repository: { full_name: 'other/repo' } },
    { status: 'in_progress' },
    { conclusion: 'failure' },
    { head_branch: 'untrusted-branch' },
  ]) {
    const api = new GitHub();
    Object.assign(api.queueRun, overrides);
    await assert.rejects(publishQueueRun(api, context, 55));
    assert.equal(api.statuses.length, 0);
  }
});

test('the shared client routes GraphQL and REST to their distinct API paths', async (t) => {
  const urls: string[] = [];
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    urls.push(url);
    return new Response('{}');
  });
  const api = client({ GITHUB_REPOSITORY: 'owner/repo' });
  await api.request('POST', '/graphql', { query: '{}' });
  await api.request('GET', 'pulls/1');
  assert.deepEqual(urls, [
    'https://api.github.com/graphql',
    'https://api.github.com/repos/owner/repo/pulls/1',
  ]);
});
