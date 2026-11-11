import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import type { API, Comment, Context, Request } from './comment.mts';

import {
  acceptRequest,
  gateDecision,
  parseCommand,
  publishRun,
  readRequest,
  refreshPull,
  renderRequest,
} from './comment.mts';
import { reportJobs, reportSelection } from './changes.mts';

const head = 'a'.repeat(40);
const base = 'b'.repeat(40);
const next = 'c'.repeat(40);
const context: Context = {
  repository: 'owner/repo',
  server: 'https://github.com',
  run: 55,
  attempt: 1,
};
const command = (id = 10, body = '/quality both scopes=all static=off'): Comment => ({
  id,
  body,
  user: { login: 'maintainer', type: 'User' },
});
const record: Request = {
  request: 10,
  pr: 1,
  head,
  base,
  run: 55,
  attempt: 1,
  actor: 'maintainer',
  phase: 'queued',
  conclusion: null,
  check: 'both',
  scopes: ['data-schemas', 'api', 'server'],
  staticMutants: false,
};
const bot = (body: string, id = 100): Comment => ({
  id,
  body,
  user: { login: 'github-actions[bot]', type: 'Bot' },
});
const run = (status = 'completed', conclusion: string | null = 'success') => ({
  id: 55,
  run_attempt: 1,
  event: 'issue_comment',
  path: '.github/workflows/change-quality.yml',
  display_title: 'Quality PR #1 request 10',
  status,
  conclusion,
});

class GitHub implements API {
  permission = 'write';
  head = head;
  state = 'open';
  comments: Comment[] = [];
  statuses: { sha: string; state: string; description: string }[] = [];
  calls: { method: string; path: string; body?: object }[] = [];
  jobs = [
    { name: 'Mutation report (data-schemas)', conclusion: 'success', status: 'completed', id: 90 },
  ];
  artifacts = [{ id: 91, name: `change-mutation-data-schemas-${head}`, expired: false }];
  async request<T>(method: string, path: string, body?: object): Promise<T> {
    this.calls.push({ method, path, body });
    let result: object;
    if (path.endsWith('/permission')) result = { permission: this.permission };
    else if (path === 'pulls/1')
      result = { number: 1, state: this.state, head: { sha: this.head }, base: { sha: base } };
    else if (method === 'GET' && path.startsWith('issues/1/comments?')) {
      const page = Number(new URLSearchParams(path.split('?')[1]).get('page'));
      result = this.comments.slice((page - 1) * 100, page * 100);
    } else if (method === 'POST' && path === 'issues/1/comments') {
      const comment = bot((body as { body: string }).body, 10000 + this.comments.length);
      this.comments.push(comment);
      result = comment;
    } else if (method === 'PATCH' && path.startsWith('issues/comments/')) {
      const comment = this.comments.find(({ id }) => id === Number(path.split('/').at(-1)))!;
      comment.body = (body as { body: string }).body;
      result = comment;
    } else if (method === 'POST' && path.startsWith('statuses/')) {
      this.statuses.push({
        sha: path.slice(9),
        ...(body as { state: string; description: string }),
      });
      result = {};
    } else if (path.includes('/jobs?')) result = { jobs: this.jobs };
    else if (path.includes('/artifacts?')) result = { artifacts: this.artifacts };
    else throw new Error(`Unexpected API call: ${method} ${path}`);
    return structuredClone(result) as T;
  }
}

test('commands validate choices and lists as data, with static enabled by default', () => {
  assert.deepEqual(parseCommand('/quality mutation'), {
    check: 'mutation',
    scopes: ['data-schemas'],
    staticMutants: true,
  });
  assert.deepEqual(parseCommand('/quality risk scopes=server,api'), {
    check: 'risk',
    scopes: ['api', 'server'],
    staticMutants: true,
  });
  assert.deepEqual(parseCommand('/quality both scopes=data-schemas,server static=off'), {
    check: 'both',
    scopes: ['data-schemas', 'server'],
    staticMutants: false,
  });
  assert.equal(parseCommand('/quality ignore')?.check, 'ignore');
  assert.equal(parseCommand('ordinary comment'), undefined);
  for (const body of [
    '/quality',
    '/quality mutation scopes=api',
    '/quality both scopes=all,api',
    '/quality risk scopes=api,api',
    '/quality both static=no',
    '/quality both static=off static=on',
    '/quality ignore scopes=all',
    '/quality both $(id)',
    '/quality both scopes=api;id',
    '/quality both\nGITHUB_OUTPUT=bad',
    '/quality both unknown=x',
    '/quality both scopes=',
    '/quality both scopes=client',
  ]) {
    assert.throws(() => parseCommand(body), Error, body);
  }
  for (const check of ['risk', 'mutation', 'both']) {
    const selected = reportSelection(check, 'all');
    const jobs = reportJobs(selected.scopes, check);
    assert.equal(
      jobs.filter(({ task }) => task.check === 'risk').length,
      check === 'mutation' ? 0 : 3,
    );
    assert.equal(
      jobs.filter(({ task }) => task.check === 'mutation').length,
      check === 'risk' ? 0 : 4,
    );
    assert.ok(
      jobs.every(
        ({ task, workspace }) => task.check !== 'mutation' || workspace === 'data-schemas',
      ),
    );
  }
});

test('read access, triage, bots and closed PRs cannot start work or clear the gate', async () => {
  for (const permission of ['read', 'triage', 'none']) {
    const api = new GitHub();
    api.permission = permission;
    assert.equal(await acceptRequest(api, context, 1, command()), undefined);
    assert.equal(api.comments.length, 0);
    assert.equal(api.statuses.length, 0);
    assert.equal(api.calls.length, 1);
  }
  const api = new GitHub();
  await acceptRequest(api, context, 1, { ...command(), user: bot('').user });
  assert.equal(api.calls.length, 0);
  api.state = 'closed';
  assert.equal(await acceptRequest(api, context, 1, command()), undefined);
  assert.equal(api.comments.length, 0);
});

async function accept(api: GitHub, ctx: Context, pr: number, comment: Comment) {
  const result = await acceptRequest(api, ctx, pr, comment);
  if (result) await refreshPull(api, ctx, pr);
  return result;
}

test('one exact-head request comment moves through progress and completion with artifact links', async () => {
  const api = new GitHub();
  const accepted = await accept(api, context, 1, command());
  assert.equal(accepted?.request.head, head);
  assert.equal(api.statuses.at(-1)?.state, 'pending');
  assert.match(api.comments[0].body, /Static: \*\*off\*\*/);
  assert.match(api.comments[0].body, /actions\/runs\/55/);
  await publishRun(api, context, run('in_progress', null));
  assert.match(api.comments[0].body, /\*\*running\*\*/);
  await publishRun(api, context, run());
  assert.equal(api.comments.length, 1);
  assert.match(api.comments[0].body, /completed \(success\)/);
  assert.match(api.comments[0].body, /artifacts\/91/);
  assert.equal(api.statuses.at(-1)?.state, 'success');
  await publishRun(api, context, run('in_progress', null));
  assert.match(api.comments[0].body, /completed \(success\)/);
});

test('failures and cancellations keep the gate closed, while explicit ignore clears it', async () => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'action_required', 'skipped']) {
    const api = new GitHub();
    await accept(api, context, 1, command());
    await publishRun(api, context, run('completed', conclusion));
    assert.equal(api.statuses.at(-1)?.state, 'failure');
    await accept(api, { ...context, run: 56 }, 1, command(11, '/quality ignore'));
    assert.equal(api.statuses.at(-1)?.state, 'success');
    assert.match(api.comments[1].body, /explicitly ignored/);
    // A late result from the older request cannot undo the explicit ignore.
    await publishRun(api, context, run('completed', conclusion));
    assert.equal(api.statuses.at(-1)?.state, 'success');
  }
});

test('new heads need a fresh decision; old results and ignore decisions are marked outdated', async () => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  await publishRun(api, context, run());
  api.head = next;
  await refreshPull(api, context, 1);
  assert.match(api.comments[0].body, /\*\*Outdated:/);
  assert.match(api.comments[0].body, /artifacts\/91/);
  assert.equal(api.statuses.at(-1)?.sha, next);
  assert.equal(api.statuses.at(-1)?.state, 'pending');
  await publishRun(api, context, run());
  assert.equal(api.statuses.at(-1)?.state, 'pending');
  const accepted = await accept(api, { ...context, run: 56 }, 1, command(11, '/quality ignore'));
  assert.equal(accepted?.request.head, next);
  assert.equal(api.statuses.at(-1)?.state, 'success');
});

test('reruns reuse the request and original commit; stale attempts cannot overwrite them', async () => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  api.head = next;
  const second = { ...context, attempt: 2 };
  await accept(api, second, 1, command());
  assert.equal(api.comments.length, 1);
  assert.equal(readRequest(api.comments[0])?.head, head);
  await publishRun(api, context, run());
  assert.equal(readRequest(api.comments[0])?.phase, 'queued');
  await publishRun(api, second, { ...run(), run_attempt: 2 });
  assert.equal(readRequest(api.comments[0])?.phase, 'completed');
  assert.equal(api.statuses.at(-1)?.state, 'pending');
});

test('latest explicit request owns the gate; automatic reports and spoofed records cannot clear it', async () => {
  assert.equal(gateDecision([], head).state, 'pending');
  assert.equal(
    gateDecision(
      [
        { ...record, phase: 'completed', conclusion: 'success' },
        { ...record, request: 11 },
      ],
      head,
    ).state,
    'pending',
  );
  const forged = renderRequest(
    { ...record, check: 'ignore', scopes: [], phase: 'ignored' },
    context,
    head,
  );
  assert.equal(readRequest({ ...command(), body: forged }), undefined);
  assert.equal(readRequest(bot(forged.replace(head, 'invalid'))), undefined);
  const api = new GitHub();
  api.comments.push({ ...command(), body: forged });
  await refreshPull(api, context, 1);
  assert.equal(api.statuses.at(-1)?.state, 'pending');
  await accept(api, context, 1, command());
  const before = api.comments.at(-1)?.body;
  for (const unrelated of [
    { ...run(), event: 'pull_request' },
    { ...run(), path: '.github/workflows/other.yml' },
    { ...run(), id: 57 },
  ]) {
    await publishRun(api, context, unrelated);
    assert.equal(api.comments.at(-1)?.body, before);
  }
});

test('pagination finds old requests and excludes unrelated or expired artifacts', async () => {
  const api = new GitHub();
  api.comments = Array.from({ length: 101 }, (_, i) => command(200 + i, 'ordinary comment'));
  await accept(api, context, 1, command());
  api.artifacts.push(
    { id: 92, name: 'untrusted [link](https://example.com)', expired: false },
    { id: 93, name: `change-risk-api-${head}`, expired: true },
  );
  await publishRun(api, context, run());
  assert.equal(api.comments.length, 102);
  assert.doesNotMatch(api.comments.at(-1)!.body, /untrusted|artifacts\/93/);
  assert.equal(api.statuses.at(-1)?.state, 'success');
});

test('rerunning only failed jobs advances the attempt without reaccepting the command', async () => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  await publishRun(api, context, run('completed', 'failure'));
  assert.equal(api.statuses.at(-1)?.state, 'failure');
  await publishRun(api, context, { ...run('in_progress', null), run_attempt: 2 });
  assert.equal(readRequest(api.comments[0])?.attempt, 2);
  assert.equal(api.statuses.at(-1)?.state, 'pending');
  await publishRun(api, context, { ...run(), run_attempt: 2 });
  assert.equal(api.statuses.at(-1)?.state, 'success');
});

test('completion recovers an ignore decision when its status job was cancelled', async () => {
  const api = new GitHub();
  await acceptRequest(api, context, 1, command(10, '/quality ignore'));
  assert.equal(api.statuses.length, 0);
  await publishRun(api, context, run('completed', 'cancelled'));
  assert.equal(api.statuses.at(-1)?.state, 'success');
});

test('restoring the original commit removes the outdated label', async () => {
  const api = new GitHub();
  await accept(api, context, 1, command(10, '/quality ignore'));
  api.head = next;
  await refreshPull(api, context, 1);
  assert.match(api.comments[0].body, /Outdated:/);
  api.head = head;
  await refreshPull(api, context, 1);
  assert.doesNotMatch(api.comments[0].body, /Outdated:/);
  assert.equal(api.statuses.at(-1)?.state, 'success');
});

test('failed-job reruns show reused successful jobs and the latest retried outcome', async () => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  api.jobs = [
    { name: 'Mutation report (data-schemas)', status: 'completed', conclusion: 'failure', id: 89 },
    { name: 'Change risk (api)', status: 'completed', conclusion: 'success', id: 88 },
    { name: 'Mutation report (data-schemas)', status: 'completed', conclusion: 'success', id: 90 },
  ];
  await publishRun(api, context, { ...run(), run_attempt: 2 });
  assert.match(api.comments[0].body, /job\/88/);
  assert.match(api.comments[0].body, /job\/90/);
  assert.doesNotMatch(api.comments[0].body, /job\/89/);
});
