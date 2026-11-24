/**
 * GitHub webhook payloads for specs, built by hand from GitHub's published webhook schema.
 * Every account, repository and id is invented. The payloads carry more than the catalog
 * reads, including addresses and fields a real delivery has, so a spec can show that nothing
 * outside the named fields is copied.
 */

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type Payload = { [key: string]: Json };

const HOST = 'https://github.com';
const API = 'https://api.github.com';

export const REPOSITORY_ID = 700100;
export const INSTALLATION_ID = 4400;
export const HEAD_SHA = '9f1c2d3e4b5a69788796a5b4c3d2e1f00f1e2d3c';

export function user(login = 'example-author', id = 5001, type = 'User'): Payload {
  return {
    login,
    id,
    node_id: `U_${id}`,
    avatar_url: `https://avatars.githubusercontent.com/u/${id}?v=4`,
    gravatar_id: '',
    url: `${API}/users/${login}`,
    html_url: `${HOST}/${login}`,
    type,
    site_admin: false,
  };
}

export function repository(name = 'example-org/widgets', id = REPOSITORY_ID): Payload {
  return {
    id,
    node_id: `R_${id}`,
    name: name.split('/')[1] ?? name,
    full_name: name,
    private: true,
    owner: user(name.split('/')[0], 9001, 'Organization'),
    html_url: `${HOST}/${name}`,
    description: 'Widgets, mostly.',
    fork: false,
    url: `${API}/repos/${name}`,
    clone_url: `${HOST}/${name}.git`,
    ssh_url: `git@github.com:${name}.git`,
    hooks_url: `${API}/repos/${name}/hooks`,
    default_branch: 'main',
    visibility: 'private',
  };
}

function ref(label: string, branch: string, sha: string): Payload {
  return { label, ref: branch, sha, user: user('example-org', 9001, 'Organization') };
}

export function pullRequest(number = 42): Payload {
  return {
    url: `${API}/repos/example-org/widgets/pulls/${number}`,
    id: 880000 + number,
    node_id: `PR_${number}`,
    html_url: `${HOST}/example-org/widgets/pull/${number}`,
    diff_url: `${HOST}/example-org/widgets/pull/${number}.diff`,
    number,
    state: 'open',
    locked: false,
    title: 'Add a retry to the widget loader',
    user: user(),
    body: 'Retries the loader three times before giving up.',
    created_at: '2026-11-20T09:00:00Z',
    updated_at: '2026-11-20T10:30:00Z',
    closed_at: null,
    merged_at: null,
    merge_commit_sha: null,
    draft: false,
    head: { ...ref('example-org:retry-loader', 'retry-loader', HEAD_SHA), repo: repository() },
    base: {
      ...ref('example-org:main', 'main', '1111111111111111111111111111111111111111'),
      repo: repository(),
    },
    author_association: 'MEMBER',
  };
}

function envelope(action: string, sender: Payload): Payload {
  return {
    action,
    repository: repository(),
    organization: { login: 'example-org', id: 9001, url: `${API}/orgs/example-org` },
    installation: { id: INSTALLATION_ID, node_id: 'MDIzOkludGVncmF0aW9uSW5zdGFsbGF0aW9u' },
    sender,
  };
}

/** `X-GitHub-Event: pull_request_review`, action `submitted`. */
export function reviewSubmitted(): Payload {
  const reviewer = user('example-reviewer', 5002);
  return {
    ...envelope('submitted', reviewer),
    review: {
      id: 3100,
      node_id: 'PRR_3100',
      user: reviewer,
      body: 'The retry count should come from config.',
      commit_id: HEAD_SHA,
      submitted_at: '2026-11-20T10:31:02Z',
      state: 'changes_requested',
      html_url: `${HOST}/example-org/widgets/pull/42#pullrequestreview-3100`,
      pull_request_url: `${API}/repos/example-org/widgets/pulls/42`,
      author_association: 'COLLABORATOR',
    },
    pull_request: pullRequest(),
  };
}

/** `X-GitHub-Event: pull_request_review_comment`, action `created`. */
export function reviewCommentCreated(): Payload {
  const reviewer = user('example-reviewer', 5002);
  return {
    ...envelope('created', reviewer),
    comment: {
      url: `${API}/repos/example-org/widgets/pulls/comments/3200`,
      pull_request_review_id: 3100,
      id: 3200,
      node_id: 'PRRC_3200',
      diff_hunk: '@@ -10,6 +10,9 @@ export function load() {',
      path: 'src/loader.ts',
      commit_id: HEAD_SHA,
      original_commit_id: HEAD_SHA,
      user: reviewer,
      body: 'Three is a magic number here.',
      created_at: '2026-11-20T10:30:40Z',
      updated_at: '2026-11-20T10:30:40Z',
      html_url: `${HOST}/example-org/widgets/pull/42#discussion_r3200`,
      pull_request_url: `${API}/repos/example-org/widgets/pulls/42`,
      author_association: 'COLLABORATOR',
      line: 14,
      side: 'RIGHT',
    },
    pull_request: pullRequest(),
  };
}

/** `X-GitHub-Event: issue_comment`, action `created`, on a pull request. */
export function issueCommentCreated(): Payload {
  const author = user('example-passerby', 5003);
  return {
    ...envelope('created', author),
    issue: {
      url: `${API}/repos/example-org/widgets/issues/42`,
      html_url: `${HOST}/example-org/widgets/pull/42`,
      id: 990042,
      node_id: 'I_42',
      number: 42,
      title: 'Add a retry to the widget loader',
      user: user(),
      state: 'open',
      locked: false,
      body: 'Retries the loader three times before giving up.',
      created_at: '2026-11-20T09:00:00Z',
      updated_at: '2026-11-20T11:00:00Z',
      closed_at: null,
      author_association: 'MEMBER',
      pull_request: {
        url: `${API}/repos/example-org/widgets/pulls/42`,
        html_url: `${HOST}/example-org/widgets/pull/42`,
        merged_at: null,
      },
    },
    comment: {
      url: `${API}/repos/example-org/widgets/issues/comments/3300`,
      html_url: `${HOST}/example-org/widgets/pull/42#issuecomment-3300`,
      issue_url: `${API}/repos/example-org/widgets/issues/42`,
      id: 3300,
      node_id: 'IC_3300',
      user: author,
      created_at: '2026-11-20T11:00:00Z',
      updated_at: '2026-11-20T11:00:00Z',
      author_association: 'NONE',
      body: 'Does this also cover the offline case?',
      performed_via_github_app: null,
    },
  };
}

/** One entry of a check suite's `pull_requests`. */
export function suitePullRequest(number = 42, base = REPOSITORY_ID): Payload {
  const repo = (id: number): Payload => ({
    id,
    url: `${API}/repositories/${id}`,
    name: 'widgets',
  });
  return {
    url: `${API}/repos/example-org/widgets/pulls/${number}`,
    id: 880000 + number,
    number,
    head: { ref: 'retry-loader', sha: HEAD_SHA, repo: repo(REPOSITORY_ID) },
    base: { ref: 'main', sha: '1111111111111111111111111111111111111111', repo: repo(base) },
  };
}

/** `X-GitHub-Event: check_suite`, action `completed`. */
export function checkSuiteCompleted(): Payload {
  return {
    ...envelope('completed', user('example-author', 5001)),
    check_suite: {
      id: 6100,
      node_id: 'CS_6100',
      head_branch: 'retry-loader',
      head_sha: HEAD_SHA,
      status: 'completed',
      conclusion: 'failure',
      url: `${API}/repos/example-org/widgets/check-suites/6100`,
      before: '1111111111111111111111111111111111111111',
      after: HEAD_SHA,
      pull_requests: [suitePullRequest()],
      app: { id: 15368, slug: 'example-ci', name: 'Example CI' },
      created_at: '2026-11-20T10:20:00Z',
      updated_at: '2026-11-20T10:29:10Z',
      latest_check_runs_count: 12,
      check_runs_url: `${API}/repos/example-org/widgets/check-suites/6100/check-runs`,
      head_commit: { id: HEAD_SHA, message: 'Add a retry', timestamp: '2026-11-20T10:19:00Z' },
    },
  };
}

/** `X-GitHub-Event: pull_request`, action `closed`, merged. */
export function pullRequestClosed(): Payload {
  const merger = user('example-maintainer', 5004);
  return {
    ...envelope('closed', merger),
    number: 42,
    pull_request: {
      ...pullRequest(),
      state: 'closed',
      closed_at: '2026-11-20T12:00:00Z',
      merged_at: '2026-11-20T12:00:00Z',
      merge_commit_sha: '2222222222222222222222222222222222222222',
      merged: true,
      merged_by: merger,
    },
  };
}

/** Sets `path` (dot-separated, numbers index arrays) in place; `undefined` deletes the key. */
export function set(body: Payload, path: string, value: Json | undefined): Payload {
  const keys = path.split('.');
  const last = keys.pop() as string;
  let node: Json = body;
  for (const key of keys) {
    node = (node as { [key: string]: Json })[key];
  }
  const target = node as { [key: string]: Json };
  if (value === undefined) {
    delete target[last];
  } else {
    target[last] = value;
  }
  return body;
}
