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
const lia = {
  login: 'lia-by-librechat[bot]',
  type: 'Bot',
  id: 328778573,
} satisfies Comment['user'];
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
const prerequisiteJobs = [
  { name: 'Accept quality request', conclusion: 'success', status: 'completed', id: 70 },
  { name: 'Select changed source', conclusion: 'success', status: 'completed', id: 71 },
  { name: 'Verify quality tooling', conclusion: 'success', status: 'completed', id: 72 },
];
const run = (status = 'completed', conclusion: string | null = 'success') => ({
  id: 55,
  repository: { full_name: context.repository },
  run_attempt: 1,
  event: 'issue_comment',
  path: '.github/workflows/change-quality.yml',
  display_title: 'Quality PR #1 request 10',
  status,
  conclusion,
});

class GitHub implements API {
  permission = 'write';
  reactionError = false;
  runs = new Map<number, ReturnType<typeof run>>([[55, run()]]);
  head = head;
  state = 'open';
  comments: Comment[] = [];
  statuses: { sha: string; state: string; description: string }[] = [];
  calls: { method: string; path: string; body?: object }[] = [];
  jobs = [
    ...structuredClone(prerequisiteJobs),
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
    } else if (method === 'POST' && /^issues\/comments\/\d+\/reactions$/.test(path)) {
      if (this.reactionError) throw new Error('Reaction unavailable');
      result = { content: 'eyes' };
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
    } else if (method === 'POST' && path.endsWith('/force-cancel')) {
      const current = this.runs.get(Number(path.split('/')[2]))!;
      current.status = 'completed';
      current.conclusion = 'cancelled';
      result = {};
    } else if (method === 'GET' && /^actions\/runs\/\d+$/.test(path)) {
      result = this.runs.get(Number(path.split('/')[2])) ?? {
        ...run(),
        id: Number(path.split('/')[2]),
      };
    } else if (path.includes('/jobs?')) result = { jobs: this.jobs };
    else if (path.includes('/artifacts?')) result = { artifacts: this.artifacts };
    else throw new Error(`Unexpected API call: ${method} ${path}`);
    return structuredClone(result) as T;
  }
}

test('commands validate choices and lists as data, with all scopes and static off by default', () => {
  assert.deepEqual(parseCommand('/quality mutation'), {
    check: 'mutation',
    scopes: ['data-schemas'],
    staticMutants: false,
  });
  assert.deepEqual(parseCommand('/quality risk scopes=server,api'), {
    check: 'risk',
    scopes: ['api', 'server'],
    staticMutants: false,
  });
  assert.deepEqual(parseCommand('/quality both scopes=data-schemas,server static=off'), {
    check: 'both',
    scopes: ['data-schemas', 'server'],
    staticMutants: false,
  });
  assert.deepEqual(parseCommand('/quality check-all'), {
    check: 'both',
    scopes: ['data-schemas', 'api', 'server'],
    staticMutants: false,
  });
  assert.deepEqual(
    parseCommand('/quality check-all'),
    parseCommand('/quality both scopes=all static=off'),
  );
  assert.deepEqual(parseCommand('/quality check-all scopes=data-schemas static=on'), {
    check: 'both',
    scopes: ['data-schemas'],
    staticMutants: true,
  });
  assert.equal(parseCommand('/quality ignore')?.check, 'ignore');
  assert.equal(parseCommand('ordinary comment'), undefined);
  for (const body of [
    '/quality',
    '/quality check-all static=invalid',
    '/quality check-all scopes=client',
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

test('read access, triage, untrusted bots and closed PRs cannot start work or clear the gate', async () => {
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

test('trusted bots start exact-head requests without collaborator permissions and publish completion', async () => {
  const api = new GitHub();
  api.permission = 'none';
  const accepted = await accept(api, context, 1, { ...command(), user: lia });
  assert.equal(accepted?.request.actor, lia.login);
  assert.equal(accepted?.request.head, head);
  assert.equal(
    api.calls.some(({ path }) => path.endsWith('/permission')),
    false,
  );
  assert.equal(readRequest(api.comments[0])?.actor, lia.login);
  assert.equal(api.statuses.at(-1)?.state, 'pending');
  await publishRun(api, context, run());
  assert.equal(readRequest(api.comments[0])?.conclusion, 'success');
  assert.equal(api.statuses.at(-1)?.state, 'success');
  api.head = next;
  await refreshPull(api, context, 1);
  assert.match(api.comments[0].body, /Outdated:/);
  assert.equal(api.statuses.at(-1)?.state, 'pending');
});

test('only exact trusted bot identities can submit commands or disturb an active request', async () => {
  for (const user of [
    { ...lia, id: undefined },
    { ...lia, id: lia.id + 1 },
    { ...lia, login: 'untrusted[bot]' },
    { ...lia, login: 'lia-by-librechat-copy[bot]' },
    { ...lia, type: 'Organization' },
    bot('').user,
  ]) {
    for (const body of ['/quality check-all', '/quality ignore', '/quality both static=on']) {
      const api = new GitHub();
      running(api);
      const original = api.comments[0].body;
      assert.equal(
        await acceptRequest(api, { ...context, run: 56 }, 1, { ...command(11, body), user }),
        undefined,
      );
      assert.equal(api.calls.length, 0);
      assert.equal(api.comments.length, 1);
      assert.equal(api.comments[0].body, original);
      assert.equal(api.runs.get(55)?.status, 'in_progress');
      assert.equal(api.statuses.length, 0);
    }
  }
});

test('trusted command bots cannot forge publisher records', () => {
  const body = renderRequest({ ...record, actor: lia.login }, context, head);
  assert.equal(readRequest({ ...command(), body, user: lia }), undefined);
  assert.equal(readRequest(bot(body))?.actor, lia.login);
  for (const actor of ['lia-by-librechat[bot]extra', 'lia-by-librechat[other]', 'bad\nactor']) {
    assert.equal(readRequest(bot(renderRequest({ ...record, actor }, context, head))), undefined);
  }
});

test('trusted bots respect closed PRs and command validation before cancelling work', async () => {
  const api = new GitHub();
  running(api);
  api.state = 'closed';
  assert.equal(
    await acceptRequest(api, { ...context, run: 56 }, 1, { ...command(11), user: lia }),
    undefined,
  );
  assert.equal(api.comments.length, 1);
  assert.equal(api.statuses.length, 0);
  api.state = 'open';
  assert.equal(
    await acceptRequest(api, { ...context, run: 56 }, 1, {
      ...command(11, '/quality mutation scopes=server'),
      user: lia,
    }),
    undefined,
  );
  assert.equal(cancellations(api).length, 0);
  assert.equal(api.runs.get(55)?.status, 'in_progress');
  assert.equal(api.statuses.length, 0);
  assert.ok(api.calls.every(({ path }) => !path.endsWith('/reactions')));
});

test('trusted bots can explicitly ignore only after stopping the active quality run', async () => {
  const api = new GitHub();
  api.permission = 'none';
  running(api);
  const accepted = await acceptRequest(api, { ...context, run: 56 }, 1, {
    ...command(11, '/quality ignore'),
    user: lia,
  });
  assert.equal(accepted?.request.actor, lia.login);
  assert.equal(cancellations(api).length, 1);
  const stoppedAt = api.calls.findIndex(({ path }) => path.endsWith('/force-cancel'));
  const clearedAt = api.calls.findIndex(({ path }) => path.startsWith('statuses/'));
  assert.ok(stoppedAt < clearedAt);
  assert.equal(readRequest(api.comments[1])?.check, 'ignore');
  assert.equal(api.statuses.at(-1)?.state, 'success');
});

test('one exact-head request comment moves through progress and completion with artifact links', async () => {
  const api = new GitHub();
  const accepted = await accept(api, context, 1, command());
  assert.equal(accepted?.request.head, head);
  assert.deepEqual(
    api.calls.find(({ path }) => path.endsWith('/reactions')),
    {
      method: 'POST',
      path: 'issues/comments/10/reactions',
      body: { content: 'eyes' },
    },
  );
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

test('reruns of the current request preserve its commit; stale attempts cannot overwrite them', async () => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  const second = { ...context, attempt: 2 };
  await accept(api, second, 1, command());
  assert.equal(api.comments.length, 1);
  assert.equal(readRequest(api.comments[0])?.head, head);
  await publishRun(api, context, run());
  assert.equal(readRequest(api.comments[0])?.phase, 'queued');
  await publishRun(api, second, { ...run(), run_attempt: 2 });
  assert.equal(readRequest(api.comments[0])?.phase, 'completed');
  assert.equal(api.statuses.at(-1)?.state, 'success');
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

test('a rejected rerun cannot clear a failed decision with skipped reports', async () => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  await publishRun(api, context, run('completed', 'failure'));
  api.permission = 'read';
  assert.equal(await acceptRequest(api, { ...context, attempt: 2 }, 1, command()), undefined);
  api.jobs = [
    ...api.jobs,
    ...prerequisiteJobs.map((job) => ({
      ...job,
      id: job.id + 100,
      conclusion: job.name === 'Accept quality request' ? 'success' : 'skipped',
    })),
    { name: 'Mutation report (data-schemas)', conclusion: 'skipped', status: 'completed', id: 190 },
  ];
  api.artifacts = [];
  await publishRun(api, context, { ...run(), run_attempt: 2 });
  assert.equal(readRequest(api.comments[0])?.conclusion, 'failure');
  assert.equal(api.statuses.at(-1)?.state, 'failure');
  await refreshPull(api, context, 1);
  assert.equal(api.statuses.at(-1)?.state, 'failure');
});

test('successful workflows still require successful selection, tooling and selected reports', async () => {
  for (const name of [
    'Select changed source',
    'Verify quality tooling',
    'Mutation report (data-schemas)',
  ]) {
    for (const conclusion of ['skipped', 'failure', 'cancelled']) {
      const api = new GitHub();
      await accept(api, context, 1, command());
      api.jobs.find((job) => job.name === name)!.conclusion = conclusion;
      await publishRun(api, context, run());
      assert.equal(api.statuses.at(-1)?.state, 'failure', `${name}: ${conclusion}`);
    }
    const api = new GitHub();
    await accept(api, context, 1, command());
    if (name !== 'Mutation report (data-schemas)') {
      api.jobs = api.jobs.filter((job) => job.name !== name);
      await publishRun(api, context, run());
      assert.equal(api.statuses.at(-1)?.state, 'failure', `Missing ${name}`);
    }
  }
});

test('a verified empty selection needs no report jobs or artifacts', async () => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  api.jobs = structuredClone(prerequisiteJobs);
  api.artifacts = [];
  await publishRun(api, context, run());
  assert.equal(api.statuses.at(-1)?.state, 'success');
});

test('completion recovers an ignore decision when its status job was cancelled', async () => {
  const api = new GitHub();
  await acceptRequest(api, context, 1, command(10, '/quality ignore'));
  api.statuses = [];
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
    ...structuredClone(prerequisiteJobs),
    { name: 'Mutation report (data-schemas)', status: 'completed', conclusion: 'failure', id: 89 },
    { name: 'Change risk (api)', status: 'completed', conclusion: 'success', id: 88 },
    { name: 'Mutation report (data-schemas)', status: 'completed', conclusion: 'success', id: 90 },
  ];
  await publishRun(api, context, { ...run(), run_attempt: 2 });
  assert.match(api.comments[0].body, /job\/88/);
  assert.match(api.comments[0].body, /job\/90/);
  assert.doesNotMatch(api.comments[0].body, /job\/89/);
});

function running(api: GitHub, value: Request = record, overrides = {}) {
  api.comments.push(bot(renderRequest(value, context, value.head), 100 + api.comments.length));
  api.runs.set(value.run, {
    ...run('in_progress', null),
    id: value.run,
    display_title: `Quality PR #${value.pr} request ${value.request}`,
    ...overrides,
  });
}
const cancellations = (api: GitHub) =>
  api.calls.filter(({ path }) => path.endsWith('/force-cancel'));

test('a duplicate active command links the existing run without changing its decision', async () => {
  const api = new GitHub();
  running(api);
  const original = api.comments[0].body;
  const accepted = await acceptRequest(
    api,
    { ...context, run: 56 },
    1,
    command(11, '/quality check-all'),
  );
  assert.equal(accepted, undefined);
  assert.equal(api.comments[0].body, original);
  assert.match(api.comments[1].body, /already running.*actions\/runs\/55/);
  assert.equal(readRequest(api.comments[1]), undefined);
  assert.equal(cancellations(api).length, 0);
  assert.equal(api.statuses.length, 0);
});

test('different validated options replace the active run only after recording acceptance', async () => {
  const api = new GitHub();
  running(api);
  const accepted = await acceptRequest(
    api,
    { ...context, run: 56 },
    1,
    command(11, '/quality both scopes=all static=on'),
  );
  assert.equal(accepted?.request.staticMutants, true);
  assert.deepEqual(
    cancellations(api).map(({ path }) => path),
    ['actions/runs/55/force-cancel'],
  );
  assert.equal(api.runs.get(55)?.status, 'completed');
  assert.equal(api.statuses.at(-1)?.state, 'pending');
  const acceptedAt = api.calls.findIndex(
    ({ method, path }) => method === 'POST' && path === 'issues/1/comments',
  );
  const cancelledAt = api.calls.findIndex(({ path }) => path.endsWith('/force-cancel'));
  assert.ok(acceptedAt < cancelledAt);
});

test('a finished request can start a fresh run with the same options', async () => {
  const api = new GitHub();
  running(api, { ...record, phase: 'completed', conclusion: 'success' }, run());
  const accepted = await acceptRequest(api, { ...context, run: 56 }, 1, command(11));
  assert.equal(accepted?.request.run, 56);
  assert.equal(cancellations(api).length, 0);
  assert.equal(api.statuses.at(-1)?.state, 'pending');
});

test('ignore stops accepted quality work before clearing the gate', async () => {
  const api = new GitHub();
  running(api);
  await acceptRequest(api, { ...context, run: 56 }, 1, command(11, '/quality ignore'));
  assert.equal(cancellations(api).length, 1);
  const stoppedAt = api.calls.findIndex(({ path }) => path.endsWith('/force-cancel'));
  const clearedAt = api.calls.findIndex(({ path }) => path.startsWith('statuses/'));
  assert.ok(stoppedAt < clearedAt);
  assert.equal(api.statuses.at(-1)?.state, 'success');
});

test('invalid commands and unauthorized actors cannot disturb an active request', async () => {
  for (const [permission, body] of [
    ['read', '/quality ignore'],
    ['triage', '/quality both static=on'],
    ['write', '/quality mutation scopes=server'],
    ['write', '/quality both static=off static=on'],
  ]) {
    const api = new GitHub();
    running(api);
    api.permission = permission;
    const original = api.comments[0].body;
    assert.equal(
      await acceptRequest(api, { ...context, run: 56 }, 1, command(11, body)),
      undefined,
    );
    assert.equal(api.comments[0].body, original);
    assert.equal(api.runs.get(55)?.status, 'in_progress');
    assert.equal(cancellations(api).length, 0);
    assert.equal(api.statuses.length, 0);
    assert.ok(api.calls.every(({ path }) => !path.endsWith('/reactions')));
  }
});

test('cancellation excludes other repositories, PRs, workflows and standalone manual runs', async () => {
  for (const overrides of [
    { repository: { full_name: 'other/repo' } },
    { display_title: 'Quality PR #2 request 10' },
    { display_title: 'Quality PR #1 request 999' },
    { event: 'workflow_dispatch' },
    { event: 'pull_request' },
    { path: '.github/workflows/unrelated.yml' },
    { id: 999 },
  ]) {
    const api = new GitHub();
    running(api, record, overrides);
    await acceptRequest(api, { ...context, run: 56 }, 1, command(11, '/quality ignore'));
    assert.equal(cancellations(api).length, 0, JSON.stringify(overrides));
  }
  const api = new GitHub();
  running(api, { ...record, pr: 2 });
  await acceptRequest(api, { ...context, run: 56 }, 1, command(11, '/quality ignore'));
  assert.equal(cancellations(api).length, 0);
});

test('a new head cancels old work and needs a fresh decision', async () => {
  const api = new GitHub();
  running(api);
  api.head = next;
  await refreshPull(api, { ...context, run: 99 }, 1);
  assert.equal(cancellations(api).length, 1);
  assert.match(api.comments[0].body, /Outdated:/);
  assert.equal(api.statuses.at(-1)?.sha, next);
  assert.equal(api.statuses.at(-1)?.state, 'pending');
  await assert.rejects(acceptRequest(api, { ...context, attempt: 2 }, 1, command()), /superseded/);
});

test('an old Actions rerun cannot replace a newer accepted ignore', async () => {
  const api = new GitHub();
  running(api);
  api.comments.push(
    bot(
      renderRequest(
        { ...record, request: 11, run: 56, check: 'ignore', scopes: [], phase: 'ignored' },
        context,
        head,
      ),
      101,
    ),
  );
  await publishRun(api, { ...context, run: 99 }, { ...run('in_progress', null), run_attempt: 2 });
  assert.equal(cancellations(api).length, 1);
  assert.equal(api.statuses.at(-1)?.state, 'success');
  assert.equal(readRequest(api.comments[0])?.conclusion, 'cancelled');
});

test('delayed older comments cannot replace a newer decision', async () => {
  const api = new GitHub();
  running(api, { ...record, request: 12 });
  await assert.rejects(
    acceptRequest(api, { ...context, run: 56 }, 1, command(11, '/quality ignore')),
    /superseded/,
  );
  assert.equal(cancellations(api).length, 0);
  assert.equal(api.statuses.length, 0);
});

test('an older matching run does not hide different options in the current request', async () => {
  const api = new GitHub();
  running(api);
  running(api, { ...record, request: 11, run: 56, staticMutants: true });
  const accepted = await acceptRequest(api, { ...context, run: 57 }, 1, command(12));
  assert.equal(accepted?.request.run, 57);
  assert.deepEqual(
    cancellations(api).map(({ path }) => path),
    ['actions/runs/55/force-cancel', 'actions/runs/56/force-cancel'],
  );
});

test('failed cancellation blocks the replacement instead of starting duplicate work', async () => {
  const api = new GitHub();
  running(api);
  const request = api.request.bind(api);
  api.request = async <T,>(method: string, path: string, body?: object): Promise<T> => {
    if (path.endsWith('/force-cancel')) throw new Error('Cancellation unavailable');
    return request<T>(method, path, body);
  };
  await assert.rejects(
    acceptRequest(api, { ...context, run: 56 }, 1, command(11, '/quality both static=on')),
    /Cancellation unavailable/,
  );
  assert.equal(api.runs.get(55)?.status, 'in_progress');
  assert.equal(api.statuses.at(-1)?.state, 'pending');
});

test('failed ignore cancellation cannot clear the gate through completion or refresh', async () => {
  const api = new GitHub();
  running(api);
  const call = api.request.bind(api);
  api.request = async <T,>(method: string, path: string, body?: object): Promise<T> => {
    if (path.endsWith('/force-cancel')) throw new Error('Cancellation unavailable');
    return call<T>(method, path, body);
  };
  await assert.rejects(
    acceptRequest(api, { ...context, run: 56 }, 1, command(11, '/quality ignore')),
    /Cancellation unavailable/,
  );
  assert.equal(api.comments.length, 1);
  assert.equal(api.runs.get(55)?.status, 'in_progress');
  await publishRun(api, context, {
    ...run('completed', 'failure'),
    id: 56,
    display_title: 'Quality PR #1 request 11',
  });
  await refreshPull(api, context, 1);
  assert.equal(api.statuses.at(-1)?.state, 'pending');
  assert.ok(api.statuses.every(({ state }) => state !== 'success'));
});

test('a head change during replacement prevents old-head report jobs from starting', async () => {
  const api = new GitHub();
  running(api);
  const request = api.request.bind(api);
  api.request = async <T,>(method: string, path: string, body?: object): Promise<T> => {
    const response = await request<T>(method, path, body);
    if (path.endsWith('/force-cancel')) api.head = next;
    return response;
  };
  await assert.rejects(
    acceptRequest(api, { ...context, run: 56 }, 1, command(11, '/quality both static=on')),
    /PR head changed/,
  );
  await refreshPull(api, { ...context, run: 99 }, 1);
  assert.equal(api.statuses.at(-1)?.sha, next);
  assert.equal(api.statuses.at(-1)?.state, 'pending');
});

test('reaction failure does not stop an authorized quality request', async (t) => {
  const warning = t.mock.method(console, 'warn', () => {});
  const api = new GitHub();
  api.reactionError = true;
  const accepted = await acceptRequest(api, context, 1, command(10, '/quality check-all'));
  assert.equal(accepted?.request.head, head);
  assert.equal(api.statuses.at(-1)?.state, 'pending');
  assert.equal(warning.mock.callCount(), 1);
});
