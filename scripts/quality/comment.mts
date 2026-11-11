import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { appendFileSync, readFileSync } from 'node:fs';

import { reportSelection } from './changes.mts';

export const GATE = 'Quality decision';
const PREFIX = '<!-- quality-request ';
const SHA = /^[a-f0-9]{40}$/u;
const positive = (value: number) => Number.isSafeInteger(value) && value > 0;

export function parseCommand(body: string) {
  const parts = body.trim().split(/\s+/u);
  if (parts.shift() !== '/quality') return undefined;
  const check = parts.shift();
  if (check === 'ignore' && !parts.length) {
    return { check, scopes: [] as string[], staticMutants: true };
  }
  if (!check || !['risk', 'mutation', 'both'].includes(check)) throw new Error(usage);
  const options = new Map<string, string>();
  for (const part of parts) {
    const match = /^(scopes|static)=([a-z,-]+)$/u.exec(part);
    if (!match || options.has(match[1])) throw new Error(usage);
    options.set(match[1], match[2]);
  }
  const selection = reportSelection(check, options.get('scopes') ?? 'all');
  const mode = options.get('static') ?? 'on';
  if (!['on', 'off'].includes(mode)) throw new Error(usage);
  return { ...selection, staticMutants: mode === 'on' };
}

const usage =
  'Use `/quality risk|mutation|both scopes=all|data-schemas,api,server static=on|off` or `/quality ignore`. Mutation supports data-schemas only.';
type Command = NonNullable<ReturnType<typeof parseCommand>>;
export interface Request extends Command {
  request: number;
  pr: number;
  head: string;
  base: string;
  run: number;
  attempt: number;
  actor: string;
  phase: string;
  conclusion: string | null;
}
export interface Comment {
  id: number;
  body: string;
  user: { login: string; type: string };
}
interface Pull {
  number: number;
  state: string;
  head: { sha: string };
  base: { sha: string };
}
interface Run {
  id: number;
  run_attempt: number;
  event: string;
  path: string;
  display_title: string;
  status: string;
  conclusion: string | null;
}
interface Job {
  name: string;
  conclusion: string | null;
  status: string;
  id: number;
}
interface Artifact {
  id: number;
  name: string;
  expired: boolean;
}
export interface API {
  request<T>(method: string, path: string, body?: object): Promise<T>;
}
export interface Context {
  repository: string;
  server: string;
  run: number;
  attempt: number;
}

/** Only our bot's validated records can link a run, decision and exact PR head. */
export function readRequest(comment: Comment): Request | undefined {
  if (comment.user.type !== 'Bot' || comment.user.login !== 'github-actions[bot]') return;
  const line = comment.body.split('\n')[0];
  if (!line.startsWith(PREFIX) || !line.endsWith(' -->')) return;
  try {
    const value: Request = JSON.parse(line.slice(PREFIX.length, -4));
    if (
      ![value.request, value.pr, value.run, value.attempt].every(positive) ||
      !SHA.test(value.head) ||
      !SHA.test(value.base) ||
      !/^[a-z\d-]+$/iu.test(value.actor) ||
      !['queued', 'running', 'completed', 'ignored'].includes(value.phase) ||
      typeof value.staticMutants !== 'boolean' ||
      !Array.isArray(value.scopes) ||
      !(
        value.conclusion === null ||
        [
          'success',
          'failure',
          'cancelled',
          'timed_out',
          'action_required',
          'neutral',
          'skipped',
          'stale',
          'startup_failure',
        ].includes(value.conclusion)
      )
    )
      return;
    if (value.check === 'ignore') {
      if (value.scopes.length || value.phase !== 'ignored') return;
    } else {
      const selection = reportSelection(value.check, value.scopes.join(','));
      if (JSON.stringify(selection.scopes) !== JSON.stringify(value.scopes)) return;
    }
    return value;
  } catch {
    return;
  }
}

async function pages<T>(api: API, path: string, key?: string): Promise<T[]> {
  const all: T[] = [];
  for (let page = 1; ; page++) {
    const result = await api.request<T[] | Record<string, T[]>>(
      'GET',
      `${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`,
    );
    const items = key ? (result as Record<string, T[]>)[key] : (result as T[]);
    all.push(...items);
    if (items.length < 100) return all;
  }
}
const comments = (api: API, pr: number) => pages<Comment>(api, `issues/${pr}/comments`);
const runURL = (context: Context, run: number) =>
  `${context.server}/${context.repository}/actions/runs/${run}`;

export function renderRequest(
  request: Request,
  context: Context,
  currentHead: string,
  details = '',
) {
  const scopes = request.scopes.join(', ') || 'none';
  const url = runURL(context, request.run);
  const risk = request.check === 'risk' || request.check === 'both' ? scopes : 'none';
  const mutation =
    request.check !== 'risk' && request.scopes.includes('data-schemas')
      ? 'data-schemas (four shards)'
      : 'none';
  return [
    `${PREFIX}${JSON.stringify(request)} -->`,
    '### Quality request',
    '',
    ...(currentHead !== request.head
      ? ['**Outdated: this request is for an earlier PR commit.**', '']
      : []),
    `Commit: \`${request.head}\`. Requested by @${request.actor}.`,
    `Checks: **${request.check}**. Scopes: **${scopes}**. Static: **${request.staticMutants ? 'on' : 'off'}**${request.check === 'risk' || request.check === 'ignore' ? ' (not used)' : ''}.`,
    `Risk: ${risk}. Mutation: ${mutation}.`,
    '',
    request.check === 'ignore'
      ? 'Quality checks explicitly ignored for this commit.'
      : `Status: **${request.phase}${request.conclusion ? ` (${request.conclusion})` : ''}**. [Actions run](${url}) (attempt ${request.attempt}).`,
    ...(details ? ['', details] : []),
    '',
    'Scores are advisory. Failed tests, tool errors and incomplete reports do not clear the gate.',
  ].join('\n');
}

export function gateDecision(records: Request[], head: string) {
  const latest = records
    .filter((item) => item.head === head)
    .sort((a, b) => b.request - a.request)[0];
  if (!latest)
    return {
      state: 'pending',
      description: 'Run /quality or explicitly use /quality ignore',
      request: undefined,
    };
  if (latest.check === 'ignore')
    return {
      state: 'success',
      description: `Explicitly ignored by ${latest.actor}`,
      request: latest,
    };
  if (latest.phase !== 'completed')
    return {
      state: 'pending',
      description: 'Requested quality checks are waiting or running',
      request: latest,
    };
  return latest.conclusion === 'success'
    ? {
        state: 'success',
        description: 'Selected quality checks completed; scores are advisory',
        request: latest,
      }
    : {
        state: 'failure',
        description: 'Quality run failed or was cancelled; retry or explicitly ignore',
        request: latest,
      };
}

async function updateGate(api: API, context: Context, pr: number) {
  const pull = await api.request<Pull>('GET', `pulls/${pr}`);
  const records = (await comments(api, pr)).flatMap((comment) => {
    const record = readRequest(comment);
    return record?.pr === pr ? [record] : [];
  });
  const decision = gateDecision(records, pull.head.sha);
  await api.request('POST', `statuses/${pull.head.sha}`, {
    context: GATE,
    state: decision.state,
    description: decision.description,
    target_url: decision.request
      ? runURL(context, decision.request.run)
      : `${context.server}/${context.repository}/pull/${pr}`,
  });
}

/** Authorization precedes parsing or any expensive work. No comment text is executed. */
export async function acceptRequest(api: API, context: Context, pr: number, comment: Comment) {
  if (comment.user.type === 'Bot' || !/^\/quality(?:\s|$)/u.test(comment.body.trim())) return;
  const permission = await api.request<{
    permission: string;
    user?: { permissions?: { push?: boolean } };
  }>('GET', `collaborators/${encodeURIComponent(comment.user.login)}/permission`);
  if (
    !permission.user?.permissions?.push &&
    !['admin', 'maintain', 'write'].includes(permission.permission)
  )
    return;
  const pull = await api.request<Pull>('GET', `pulls/${pr}`);
  if (pull.state !== 'open') return;
  let command: Command;
  try {
    command = parseCommand(comment.body)!;
  } catch (error) {
    await api.request('POST', `issues/${pr}/comments`, {
      body: `Quality request was not started.\n\n${error instanceof Error ? error.message : usage}`,
    });
    return;
  }
  const existing = (await comments(api, pr)).find(
    (item) => readRequest(item)?.request === comment.id,
  );
  const previous = existing && readRequest(existing);
  // Re-running Actions preserves the original request's commit and options.
  const request: Request = {
    ...(previous ?? {
      ...command,
      request: comment.id,
      pr,
      head: pull.head.sha,
      base: pull.base.sha,
      actor: comment.user.login,
    }),
    run: context.run,
    attempt: context.attempt,
    phase: (previous ?? command).check === 'ignore' ? 'ignored' : 'queued',
    conclusion: null,
  };
  if (!SHA.test(request.head) || !SHA.test(request.base)) throw new Error('Invalid PR commit');
  const body = renderRequest(request, context, pull.head.sha);
  const response = await api.request<Comment>(
    existing ? 'PATCH' : 'POST',
    existing ? `issues/comments/${existing.id}` : `issues/${pr}/comments`,
    { body },
  );
  return { request, comment: response.id };
}

/** Refresh from GitHub's job metadata, never by executing or rendering artifact contents. */
export async function publishRun(api: API, context: Context, run: Run) {
  const match = /^Quality PR #(\d+) request (\d+)$/u.exec(run.display_title);
  if (
    run.event !== 'issue_comment' ||
    run.path !== '.github/workflows/change-quality.yml' ||
    !match
  )
    return;
  const pr = Number(match[1]);
  const source = Number(match[2]);
  const comment = (await comments(api, pr)).find((item) => {
    const record = readRequest(item);
    return (
      record?.request === source &&
      record.pr === pr &&
      record.run === run.id &&
      record.attempt <= run.run_attempt
    );
  });
  if (!comment) return;
  const request = readRequest(comment)!;
  if (request.check === 'ignore') {
    await updateGate(api, context, pr);
    return;
  }
  const jobs = await pages<Job>(api, `actions/runs/${run.id}/jobs?filter=all`, 'jobs');
  // Failed-job reruns reuse successful jobs from earlier attempts.
  const latestJobs = new Map<string, Job>();
  for (const job of jobs) {
    if ((latestJobs.get(job.name)?.id ?? 0) < job.id) latestJobs.set(job.name, job);
  }
  const reports = [...latestJobs.values()].filter(({ name }) =>
    /^(?:Change risk|Mutation testing [1-4]\/4|Mutation report) \((?:data-schemas|api|server)\)$/u.test(
      name,
    ),
  );
  const artifacts = await pages<Artifact>(api, `actions/runs/${run.id}/artifacts`, 'artifacts');
  const links = artifacts.filter(
    ({ name, expired }) =>
      !expired &&
      new RegExp(
        `^change-(?:risk|mutation)-(?:data-schemas|api|server)-${request.head}(?:-shard-[1-4])?$`,
        'u',
      ).test(name),
  );
  // A delayed progress event must not replace a terminal report.
  if (
    request.attempt === run.run_attempt &&
    request.phase === 'completed' &&
    run.status !== 'completed'
  )
    return;
  request.attempt = run.run_attempt;
  request.phase = run.status === 'completed' ? 'completed' : 'running';
  request.conclusion = run.status === 'completed' ? run.conclusion : null;
  const details = [
    ...(reports.length
      ? [
          '| Check | Result |',
          '| --- | --- |',
          ...reports.map(
            (job) =>
              `| [${job.name}](${runURL(context, run.id)}/job/${job.id}) | ${job.conclusion ?? job.status} |`,
          ),
        ]
      : [
          'No report jobs have started. A successful empty selection means no supported source changed.',
        ]),
    '',
    ...(links.length
      ? [
          'Reports and scores:',
          ...links.map(
            (artifact, index) =>
              `${index + 1}. [${artifact.name}](${runURL(context, run.id)}/artifacts/${artifact.id})`,
          ),
        ]
      : ['No report artifacts are available.']),
  ].join('\n');
  const pull = await api.request<Pull>('GET', `pulls/${pr}`);
  await api.request('PATCH', `issues/comments/${comment.id}`, {
    body: renderRequest(request, context, pull.head.sha, details),
  });
  await updateGate(api, context, pr);
}

export async function refreshPull(api: API, context: Context, pr: number) {
  const pull = await api.request<Pull>('GET', `pulls/${pr}`);
  for (const comment of await comments(api, pr)) {
    const request = readRequest(comment);
    if (!request || request.pr !== pr) continue;
    // Keep results and artifact links, including when a force push restores the same commit.
    const stale = '\n**Outdated: this request is for an earlier PR commit.**\n';
    const clean = comment.body.replace(stale, '');
    const body =
      request.head === pull.head.sha
        ? clean
        : clean.replace('### Quality request\n', `### Quality request\n${stale}`);
    if (body === comment.body) continue;
    await api.request('PATCH', `issues/comments/${comment.id}`, { body });
  }
  await updateGate(api, context, pr);
}

export function client(env: NodeJS.ProcessEnv): API {
  return {
    async request<T>(method: string, path: string, body?: object): Promise<T> {
      const response = await fetch(
        `${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}/${path}`,
        {
          method,
          headers: {
            accept: 'application/vnd.github+json',
            authorization: `Bearer ${env.GH_TOKEN}`,
            'content-type': 'application/json',
            'x-github-api-version': '2022-11-28',
          },
          body: body ? JSON.stringify(body) : undefined,
          signal: AbortSignal.timeout(30000),
        },
      );
      if (!response.ok)
        throw new Error(`GitHub ${method} ${path.split('?')[0]} failed: HTTP ${response.status}`);
      return (await response.json()) as T;
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const env = process.env;
  const api = client(env);
  const context = {
    repository: env.GITHUB_REPOSITORY!,
    server: env.GITHUB_SERVER_URL!,
    run: Number(env.GITHUB_RUN_ID),
    attempt: Number(env.GITHUB_RUN_ATTEMPT),
  };
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH!, 'utf8'));
  if (process.argv[2] === 'request' && event.issue?.pull_request) {
    const accepted = await acceptRequest(api, context, event.issue.number, event.comment);
    if (accepted && env.GITHUB_OUTPUT) {
      const { request } = accepted;
      appendFileSync(
        env.GITHUB_OUTPUT,
        Object.entries({
          decision: true,
          accepted: request.check !== 'ignore',
          head: request.head,
          base: request.base,
          scope: request.scopes.join(','),
          check: request.check,
          static: request.staticMutants ? 'on' : 'off',
        })
          .map(([key, value]) => `${key}=${value}\n`)
          .join(''),
      );
    }
  } else if (process.argv[2] === 'decision') {
    await refreshPull(api, context, event.issue.number);
  } else if (process.argv[2] === 'progress') {
    await publishRun(api, context, await api.request<Run>('GET', `actions/runs/${context.run}`));
  } else if (env.GITHUB_EVENT_NAME === 'workflow_run') {
    // Read the current attempt so a late event cannot replace a newer rerun's result.
    await publishRun(
      api,
      context,
      await api.request<Run>('GET', `actions/runs/${event.workflow_run.id}`),
    );
  } else if (env.GITHUB_EVENT_NAME === 'pull_request_target') {
    await refreshPull(api, context, event.pull_request.number);
  }
}
