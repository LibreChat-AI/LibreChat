import { test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { strict as assert } from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';

import type { Finding, QualityFindings } from './findings.mts';
import type { API, Comment, Context, Request } from './comment.mts';

import {
  GATE_FOOTER,
  acceptRequest,
  gateDecision,
  parseCommand,
  publishRun,
  readRequest,
  refreshPull,
  renderRequest,
} from './comment.mts';
import { reportJobs, reportSelection } from './changes.mts';
import { COMMENT_LIMIT } from './render.mts';
import { SCHEMA, unavailableMutation, unavailableRisk } from './findings.mts';

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
interface Job {
  name: string;
  conclusion: string | null;
  status: string;
  id: number;
  steps?: { name: string; conclusion: string | null }[];
}
const reportJob: Job = {
  name: 'Quality report',
  conclusion: 'success',
  status: 'completed',
  id: 95,
  steps: [
    { name: 'Upload quality report', conclusion: 'success' },
    { name: 'Upload report findings', conclusion: 'success' },
  ],
};
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
  jobs: Job[] = [
    ...structuredClone(prerequisiteJobs),
    { name: 'Mutation report (data-schemas)', conclusion: 'success', status: 'completed', id: 90 },
    structuredClone(reportJob),
  ];
  artifacts = [{ id: 91, name: 'quality-report', expired: false }];
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
  assert.match(api.comments[0].body, /Static mutants: \*\*off\*\*/);
  // The verdict leads, then the status; the request facts follow as one list item each.
  assert.match(
    api.comments[0].body,
    /### Quality report\n\n\*\*Gate: pending\.\*\* .*\n\nStatus: .*\n\n- Commit: /u,
  );
  assert.match(api.comments[0].body, /actions\/runs\/55/);
  await publishRun(api, context, run('in_progress', null));
  assert.match(api.comments[0].body, /\*\*running\*\*/);
  await publishRun(api, context, run());
  assert.equal(api.comments.length, 1);
  assert.match(api.comments[0].body, /completed \(success\)/);
  assert.match(api.comments[0].body, /\*\*Gate: open\.\*\*/);
  assert.match(
    api.comments[0].body,
    /\[All data\]\(https:\/\/github\.com\/owner\/repo\/actions\/runs\/55\/artifacts\/91\)/,
  );
  assert.match(
    api.comments[0].body,
    /\[Run page\]\(https:\/\/github\.com\/owner\/repo\/actions\/runs\/55\)/,
  );
  assert.equal(api.statuses.at(-1)?.state, 'success');
  await publishRun(api, context, run('in_progress', null));
  assert.match(api.comments[0].body, /completed \(success\)/);
});

test('check rows are sorted by kind, scope and shard; only the final report is linked', async () => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  const job = (name: string, id: number) => ({
    name,
    status: 'completed',
    conclusion: 'success',
    id,
  });
  api.jobs = [
    ...structuredClone(prerequisiteJobs),
    job('Mutation report (data-schemas)', 80),
    job('Mutation testing 3/4 (data-schemas)', 81),
    job('Change risk (server)', 82),
    job('Mutation testing 1/4 (data-schemas)', 83),
    job('Change risk (data-schemas)', 84),
    job('Mutation testing 4/4 (data-schemas)', 85),
    job('Change risk (api)', 86),
    job('Mutation testing 2/4 (data-schemas)', 87),
    structuredClone(reportJob),
  ];
  api.artifacts = [
    `quality-internal-mutation-data-schemas-${head}-shard-2`,
    `quality-internal-risk-server-${head}`,
    `quality-internal-mutation-data-schemas-${head}`,
    'quality-internal-findings',
    'quality-report',
  ].map((name, index) => ({ id: 200 + index, name, expired: false }));
  await publishRun(api, context, run());
  const body = api.comments[0].body;
  const rows = [...body.matchAll(/^\| \[([^\]]+)\]/gmu)].map(([, name]) => name);
  assert.deepEqual(rows, [
    'Change risk (data-schemas)',
    'Change risk (api)',
    'Change risk (server)',
    'Mutation testing 1/4 (data-schemas)',
    'Mutation testing 2/4 (data-schemas)',
    'Mutation testing 3/4 (data-schemas)',
    'Mutation testing 4/4 (data-schemas)',
    'Mutation report (data-schemas)',
  ]);
  assert.match(body, /<details><summary>Jobs \(8\)<\/summary>/u);
  assert.match(body, /\[All data\]\([^)]*\/artifacts\/204\)/u);
  assert.doesNotMatch(body, /artifacts\/20[0-3]\b|quality-internal/u);
});

test('the request footer names what closes the gate and what stays advisory', () => {
  const body = renderRequest(record, context, head);
  assert.ok(body.endsWith(GATE_FOOTER));
  assert.match(GATE_FOOTER, /every report job succeed/u);
  assert.match(GATE_FOOTER, /incomplete mutation report/u);
  assert.match(GATE_FOOTER, /change-risk file marked incomplete or unavailable.*does not close/su);
  assert.doesNotMatch(GATE_FOOTER, /incomplete reports keep the gate closed/u);
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
    assert.doesNotMatch(api.comments[1].body, /Scopes:|Mutation testing|Status:/u);
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
  api.artifacts.unshift(
    { id: 92, name: 'untrusted [link](https://example.com)', expired: false },
    { id: 93, name: 'quality-report', expired: true },
  );
  await publishRun(api, context, run());
  assert.equal(api.comments.length, 102);
  assert.doesNotMatch(api.comments.at(-1)!.body, /untrusted|artifacts\/9[23]/);
  assert.match(api.comments.at(-1)!.body, /artifacts\/91/);
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

const survivor = (
  index: number,
  original = 'a > b',
  file = 'packages/data-schemas/src/x.js',
): Finding => ({
  key: createHash('sha256').update(`${file}:${index}:${original}`).digest('hex'),
  file,
  line: index + 1,
  column: 1,
  endLine: index + 1,
  endColumn: 5,
  mutator: 'EqualityOperator',
  original,
  replacement: 'a >= b',
  source: `  if (${original}) {`,
  mutated: '  if (a >= b) {',
  status: 'Survived',
  rank: 41,
  tags: ['behavior'],
  reason: 'Survived',
});

const findingsFor = (
  findings: Finding[],
  overrides: Partial<QualityFindings> = {},
): QualityFindings => ({
  schema: SCHEMA,
  repository: context.repository,
  pr: 1,
  base,
  head,
  risk: [unavailableRisk('server')],
  mutation: [
    {
      ...unavailableMutation(),
      status: 'complete',
      planDigest: 'abc123',
      counts: { ...unavailableMutation().counts, killed: 3, survived: findings.length },
      scores: { killedByAssertion: 50, stryker: 50 },
      findings,
    },
  ],
  ...overrides,
});

function findingsDir(t: { after(fn: () => void): void }, data?: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'quality-comment-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  if (data !== undefined) writeFileSync(join(directory, 'findings.json'), JSON.stringify(data));
  return directory;
}

test('a completed run renders the validated findings with untrusted text escaped', async (t) => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  const hostile = survivor(
    0,
    '`x` @maintainers </summary><img src=x>',
    'packages/data-schemas/src/</summary>@team.js',
  );
  const dir = findingsDir(t, findingsFor([hostile, survivor(5)]));
  await publishRun(api, context, run(), { findingsDir: dir, hints: 10 });
  const body = api.comments[0].body;
  assert.match(body, /^### Quality report\n\n\*\*Gate: open\.\*\*/mu);
  assert.match(body, /#### Change risk[\s\S]*\| server \| report unavailable \|/u);
  assert.match(body, /#### Mutation testing/u);
  assert.match(body, /\| data-schemas \| 3 \| 2 \|/u);
  assert.match(body, /<code>packages\/data-schemas\/src\/&lt;\/summary&gt;@team\.js<\/code>/u);
  assert.match(
    body,
    /\n```diff\n-  if \(`x` @maintainers <\/summary><img src=x>\) \{\n\+  if \(a >= b\) \{\n```\n/u,
  );
  assert.doesNotMatch(body, /(^|[^`])@(maintainers|team)\b(?![^`]*`)/mu);
  // Report sections come before the folded job table and the links.
  assert.ok(body.indexOf('#### Mutation testing') < body.indexOf('<details><summary>Jobs'));
  assert.ok(body.indexOf('<details><summary>Jobs') < body.indexOf('[All data]'));
});

test('findings are read only after the trusted report job uploaded them', async (t) => {
  const api = new GitHub();
  api.jobs = api.jobs.map((job) =>
    job.name === 'Quality report'
      ? { ...job, steps: job.steps!.map((step) => ({ ...step, conclusion: 'failure' })) }
      : job,
  );
  await accept(api, context, 1, command());
  await publishRun(api, context, run(), {
    findingsDir: findingsDir(t, findingsFor([survivor(0)])),
  });
  const body = api.comments[0].body;
  assert.match(body, /did not upload its findings/u);
  assert.doesNotMatch(body, /#### Mutation testing|\[All data\]/u);
  // A same-named job without the trusted step cannot stand in for it either.
  const spoof = new GitHub();
  spoof.jobs = spoof.jobs.map((job) =>
    job.name === 'Quality report' ? { ...job, steps: [] } : job,
  );
  await accept(spoof, context, 1, command());
  await publishRun(spoof, context, run(), {
    findingsDir: findingsDir(t, findingsFor([survivor(0)])),
  });
  assert.match(spoof.comments[0].body, /did not upload its findings/u);
});

test('findings for another request, malformed files and a moved head are not rendered', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  for (const [data, note] of [
    [findingsFor([survivor(0)], { head: next }), /Report data was rejected: .*head/u],
    [findingsFor([survivor(0)], { pr: 2 }), /Report data was rejected/u],
    [{ ...findingsFor([survivor(0)]), extra: true }, /Report data was rejected/u],
    [undefined, /No report data was downloaded/u],
  ] as const) {
    const api = new GitHub();
    await accept(api, context, 1, command());
    await publishRun(api, context, run(), { findingsDir: findingsDir(t, data) });
    assert.match(api.comments[0].body, note);
    assert.doesNotMatch(api.comments[0].body, /#### Mutation testing/u);
  }
  const api = new GitHub();
  await accept(api, context, 1, command());
  api.head = next;
  await publishRun(api, context, run(), {
    findingsDir: findingsDir(t, findingsFor([survivor(0)])),
  });
  assert.match(api.comments[0].body, /PR head moved after this run/u);
  assert.doesNotMatch(api.comments[0].body, /#### Mutation testing/u);
  assert.ok(warn.mock.callCount() >= 3);
});

test('a large report is cut by rank to fit one comment', async (t) => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  const many = Array.from({ length: 600 }, (_, index) =>
    survivor(index, `${'x'.repeat(300)}${index}`),
  );
  await publishRun(api, context, run(), { findingsDir: findingsDir(t, findingsFor(many)) });
  const body = api.comments[0].body;
  assert.ok(body.length <= COMMENT_LIMIT, `${body.length}`);
  assert.match(body, /_\d+ more survivors in report\.md\._/u);
  assert.match(body, /\[Line 1\]\(/u);
  assert.match(body, /\[All data\]/u);
});

test('a closed gate names its blockers in the verdict', async () => {
  const api = new GitHub();
  api.jobs = api.jobs.map((job) =>
    job.name === 'Mutation report (data-schemas)' ? { ...job, conclusion: 'failure' } : job,
  );
  await accept(api, context, 1, command());
  await publishRun(api, context, run('completed', 'failure'));
  assert.match(
    api.comments[0].body,
    /\*\*Gate: closed\.\*\* Blocked by: Mutation report \(data-schemas\) \(failure\), the workflow \(failure\)\./u,
  );
});

test('outdated marking also applies to comments with the earlier request heading', async () => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  api.comments[0].body = api.comments[0].body.replace(
    '### Quality report\n',
    '### Quality request\n',
  );
  api.head = next;
  await refreshPull(api, context, 1);
  assert.match(api.comments[0].body, /### Quality request\n\n\*\*Outdated: /u);
});

test('a delayed progress event keeps the completed report; a new attempt replaces it', async (t) => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  const dir = findingsDir(t, findingsFor([survivor(0)]));
  await publishRun(api, context, run(), { findingsDir: dir });
  const report = api.comments[0].body;
  assert.match(report, /#### Mutation testing/u);
  // Even after the head moved, the late event neither cancels the finished run nor rewrites it.
  api.head = next;
  const calls = api.calls.length;
  await publishRun(api, context, run('in_progress', null));
  assert.equal(api.comments[0].body, report);
  assert.ok(api.calls.slice(calls).every(({ method }) => method === 'GET'));
  api.head = head;
  await publishRun(api, context, { ...run('in_progress', null), run_attempt: 2 });
  assert.match(api.comments[0].body, /\*\*running\*\*/u);
  assert.match(api.comments[0].body, /attempt 2/u);
  assert.doesNotMatch(api.comments[0].body, /#### Mutation testing/u);
});

test('a newer request gets its own report and leaves the earlier comment alone', async (t) => {
  const api = new GitHub();
  await accept(api, context, 1, command());
  await publishRun(api, context, run(), {
    findingsDir: findingsDir(t, findingsFor([survivor(0)])),
  });
  const first = api.comments[0].body;
  api.runs.set(56, { ...run(), id: 56, display_title: 'Quality PR #1 request 11' });
  await accept(api, { ...context, run: 56 }, 1, command(11, '/quality check-all'));
  const second = { ...run(), id: 56, display_title: 'Quality PR #1 request 11' };
  await publishRun(api, { ...context, run: 56 }, second, {
    findingsDir: findingsDir(t, findingsFor([survivor(1)])),
  });
  assert.equal(api.comments[0].body, first);
  assert.match(api.comments[1].body, /\[Line 2\]\(/u);
  assert.match(api.comments[1].body, /#### Mutation testing/u);
});
