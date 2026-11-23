import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import type { API, Comment, Context } from './comment.mts';

import { GATE, client, gateDecision, readRequest } from './comment.mts';

interface Group {
  base_sha: string;
  head_sha: string;
  base_ref: string;
  head_ref: string;
}
interface Comparison {
  status: string;
  total_commits: number;
  merge_base_commit: { sha: string };
  commits: { sha: string; parents: { sha: string }[] }[];
}
interface Pull {
  number: number;
  state: string;
  headRefOid: string;
  baseRefName: string;
  comments: {
    pageInfo: { hasNextPage: boolean };
    nodes: {
      databaseId: number;
      body: string;
      author: { __typename: string; login: string } | null;
    }[];
  };
}
interface Association {
  associatedPullRequests: {
    pageInfo: { hasNextPage: boolean };
    nodes: Pull[];
  };
}

/** Merge parents preserve source heads. Squash/rebase groups cannot prove that identity. */
export async function publishGroup(api: API, context: Context, group: Group) {
  if (
    ![group.base_sha, group.head_sha].every((sha) => /^[a-f0-9]{40}$/u.test(sha)) ||
    group.base_sha === group.head_sha ||
    !group.base_ref.startsWith('refs/heads/') ||
    !group.head_ref.startsWith('refs/heads/gh-readonly-queue/')
  )
    throw new Error('Invalid merge group');
  const status = (state: string, description: string) =>
    api.request('POST', `statuses/${group.head_sha}`, {
      context: GATE,
      state,
      description,
      target_url: `${context.server}/${context.repository}/actions/runs/${context.run}`,
    });
  await status('pending', 'Verifying exact-head quality decisions for this merge group');
  try {
    const path = `compare/${group.base_sha}...${group.head_sha}?per_page=100`;
    const first = await api.request<Comparison>('GET', `${path}&page=1`);
    if (
      first.status !== 'ahead' ||
      first.merge_base_commit.sha !== group.base_sha ||
      !Number.isSafeInteger(first.total_commits) ||
      first.total_commits < 1 ||
      first.total_commits > 1000
    )
      throw new Error('Unresolved merge group comparison');
    const rest = await Promise.all(
      Array.from({ length: Math.ceil(first.total_commits / 100) - 1 }, (_, index) =>
        api.request<Comparison>('GET', `${path}&page=${index + 2}`),
      ),
    );
    const commits = [first, ...rest].flatMap((page) => page.commits);
    const bySHA = new Map(commits.map((commit) => [commit.sha, commit]));
    if (commits.length !== first.total_commits || bySHA.size !== commits.length)
      throw new Error('Incomplete merge group comparison');
    const heads: string[] = [];
    for (let sha = group.head_sha; sha !== group.base_sha; ) {
      const commit = bySHA.get(sha);
      if (!commit || commit.parents.length !== 2 || heads.length >= 100)
        throw new Error('Unsupported merge group topology; merge commits are required');
      const head = commit.parents[1].sha;
      if (!/^[a-f0-9]{40}$/u.test(head) || heads.includes(head))
        throw new Error('Ambiguous merge group source head');
      heads.push(head);
      sha = commit.parents[0].sha;
    }
    const [owner, name] = context.repository.split('/');
    const pulls: Pull[] = [];
    // Batch source-head associations rather than issuing a lookup for every commit.
    for (let offset = 0; offset < heads.length; offset += 20) {
      const batch = heads.slice(offset, offset + 20);
      const result = await api.request<{
        errors?: object[];
        data?: { repository: Record<string, Association | null> };
      }>('POST', '/graphql', {
        query: `query($owner: String!, $name: String!) {
          repository(owner: $owner, name: $name) {
            ${batch
              .map(
                (sha, index) => `p${index}: object(oid: "${sha}") {
              ... on Commit { associatedPullRequests(first: 100) {
                pageInfo { hasNextPage }
                nodes {
                  number state headRefOid baseRefName
                  comments(first: 100) {
                    pageInfo { hasNextPage }
                    nodes { databaseId body author { __typename login } }
                  }
                }
              } }
            }`,
              )
              .join('\n')}
          }
        }`,
        variables: { owner, name },
      });
      if (result.errors?.length || !result.data?.repository)
        throw new Error('Merge group source associations unavailable');
      for (const [index, head] of batch.entries()) {
        const associated = result.data.repository[`p${index}`]?.associatedPullRequests;
        const matches = associated?.nodes.filter(
          (pull) =>
            pull.state === 'OPEN' &&
            pull.headRefOid === head &&
            `refs/heads/${pull.baseRefName}` === group.base_ref,
        );
        if (!associated || associated.pageInfo.hasNextPage || matches?.length !== 1)
          throw new Error('Merge group source PR is missing or ambiguous');
        pulls.push(matches[0]);
      }
    }
    const decisions = await Promise.all(
      pulls.map(async (pull) => {
        const items: Comment[] = pull.comments.nodes.map((item) => ({
          id: item.databaseId,
          body: item.body,
          user: {
            type: item.author?.__typename ?? '',
            login:
              item.author?.__typename === 'Bot'
                ? `${item.author.login}[bot]`
                : (item.author?.login ?? ''),
          },
        }));
        for (let page = 2; pull.comments.pageInfo.hasNextPage; page++) {
          const more = await api.request<Comment[]>(
            'GET',
            `issues/${pull.number}/comments?per_page=100&page=${page}`,
          );
          items.push(...more);
          if (more.length < 100) break;
        }
        const records = items.flatMap((item) => {
          const request = readRequest(item);
          return request?.pr === pull.number ? [request] : [];
        });
        return gateDecision(records, pull.headRefOid);
      }),
    );
    const [ref, base] = await Promise.all(
      [group.head_ref, group.base_ref].map((ref) =>
        api.request<{ object: { sha: string } }>('GET', `git/ref/${ref.replace(/^refs\//u, '')}`),
      ),
    );
    if (ref.object.sha !== group.head_sha || base.object.sha !== group.base_sha)
      throw new Error('Merge group was superseded');
    const success = decisions.every((decision) => decision.state === 'success');
    await status(
      success ? 'success' : 'failure',
      success
        ? 'Every incorporated PR head has an explicit successful quality decision'
        : 'An incorporated PR head needs a successful quality request or explicit ignore',
    );
  } catch (error) {
    await status(
      'failure',
      'Cannot verify queue quality decisions; merge commits and exact PR heads are required',
    );
    throw error;
  }
}

export async function publishQueueRun(api: API, context: Context, id: number) {
  const run = await api.request<{
    event: string;
    path: string;
    head_sha: string;
    head_branch: string;
    status: string;
    conclusion: string;
    repository: { full_name: string };
  }>('GET', `actions/runs/${id}`);
  if (
    run.event !== 'merge_group' ||
    run.path !== '.github/workflows/change-quality.yml' ||
    run.repository.full_name.toLowerCase() !== context.repository.toLowerCase() ||
    run.status !== 'completed' ||
    run.conclusion !== 'success'
  )
    throw new Error('Expected a completed queue quality request');
  const branch = /^gh-readonly-queue\/(.+)\/pr-\d+-[a-f0-9]+$/u.exec(run.head_branch)?.[1];
  if (!branch) throw new Error('Invalid queue branch');
  const base = await api.request<{ object: { sha: string } }>('GET', `git/ref/heads/${branch}`);
  await publishGroup(api, context, {
    head_sha: run.head_sha,
    head_ref: `refs/heads/${run.head_branch}`,
    base_sha: base.object.sha,
    base_ref: `refs/heads/${branch}`,
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = process.env;
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, 'utf8'));
  if (env.GITHUB_EVENT_NAME !== 'workflow_run') throw new Error('Expected a workflow completion');
  await publishQueueRun(
    client(env),
    {
      repository: env.GITHUB_REPOSITORY!,
      server: env.GITHUB_SERVER_URL!,
      run: Number(env.GITHUB_RUN_ID),
      attempt: Number(env.GITHUB_RUN_ATTEMPT),
    },
    event.workflow_run.id,
  );
}
