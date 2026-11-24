import { AGENT_EVENT_TYPES } from 'librechat-data-provider';
import type { AgentEventProvider, AgentEventType } from 'librechat-data-provider';
import type { Item } from './item';
import { excerpt, line, link } from './text';
import { isId } from './item';

/** Longest pull request title kept. */
const TITLE = 256;
/** Longest account name kept; GitHub's own limit is well under it. */
const LOGIN = 100;

/**
 * The bounds a deployment may want to change. The caller passes them, read from its own
 * configuration and already validated as positive integers; `LIMITS` is what applies when it
 * passes none.
 */
export interface Limits {
  /**
   * Longest copy of a review's or a comment's text, in characters. It is an excerpt for the
   * turn's first message, which also links to the full text, and it bounds what a stranger
   * can put in a queued delivery and in front of the model.
   */
  excerpt: number;
  /** Most pull requests one check suite becomes events for; the rest are left out. */
  fanout: number;
}

export const LIMITS: Readonly<Limits> = { excerpt: 2000, fanout: 10 };

const WORD = /^[a-z_]{1,32}$/i;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
/** `owner/name`. An owner has no dots, and a name is never `.` or `..`, so it is safe in a path. */
const REPOSITORY = /^[A-Za-z0-9_-]{1,100}\/(?!\.{1,2}$)[\w.-]{1,100}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** What each event type is called by its provider: for GitHub, the header and the action. */
export interface Entry {
  provider: AgentEventProvider;
  event: string;
  action: string;
}

/** The fixed list of events an agent can be subscribed to, by stored id. */
export const catalog: Readonly<Record<AgentEventType, Entry>> = {
  'github.pull_request_review.submitted': {
    provider: 'github',
    event: 'pull_request_review',
    action: 'submitted',
  },
  'github.pull_request_review_comment.created': {
    provider: 'github',
    event: 'pull_request_review_comment',
    action: 'created',
  },
  'github.issue_comment.created': { provider: 'github', event: 'issue_comment', action: 'created' },
  'github.check_suite.completed': { provider: 'github', event: 'check_suite', action: 'completed' },
  'github.pull_request.closed': { provider: 'github', event: 'pull_request', action: 'closed' },
};

/** Who caused an event. For a review or a comment this is its author. */
export interface Actor {
  id: number;
  login: string;
  /** True for an account GitHub types as a bot, such as an app's own. */
  bot: boolean;
  /**
   * The author's relation to the repository as GitHub reports it on reviews and comments,
   * lower-cased: `owner`, `member`, `collaborator`, `contributor`, `none` and so on. It is a
   * hint for filtering, not proof of write access.
   */
  association?: string;
}

export interface Repo {
  id: number;
  /** `owner/name` as it reads today. Display text and filter input; never an identity. */
  name: string;
}

/**
 * One thing that happened to one item, reduced to what routing and the turn's first message
 * need. Every field is copied by name from the payload, so nothing else in a delivery can
 * reach a queue, a log or a prompt through it. Identity fields are required and exact; the
 * display fields are optional, bounded, and dropped when they do not read cleanly or are
 * longer than anything GitHub sends.
 */
export interface Occurrence {
  type: AgentEventType;
  item: Item;
  actor: Actor;
  repo: Repo;
  /** The app installation that delivered the event, when the payload names one. */
  installation?: number;
  /** Unix time in milliseconds, from the payload. */
  occurredAt: number;
  /** The pull request's title, at most 256 characters. */
  title?: string;
  /**
   * A review's verdict (`approved`, `changes_requested`, `commented`), a check suite's
   * conclusion (`success`, `failure`, ...), or `merged` or `closed` for a closed pull request.
   */
  state?: string;
  /** The page of the review, the comment or the pull request. */
  url?: string;
  /** The review's or comment's text, at most `Limits.excerpt` characters, credentials removed. */
  text?: string;
  /** The commit a review, a review comment or a check suite applies to. */
  sha?: string;
}

/**
 * Why a delivery produced no event. `event` and `action` mean the catalog does not list it;
 * `item` means it is listed but is not about something that can be watched, such as a comment
 * on a plain issue or a check suite that names no pull request. All three are expected, and
 * the delivery should be acknowledged and dropped.
 */
export type Ignored = 'event' | 'action' | 'item';

export type Outcome =
  | { ok: true; value: Occurrence[] }
  | { ok: false; error: { code: 'ignored'; reason: Ignored } }
  /** A listed event whose payload could not be read; `field` is the first path that failed. */
  | { ok: false; error: { code: 'malformed'; field: string } };

type Body = Record<string, unknown>;

/** What one reader takes from a payload; the rest of an occurrence is common to all of them. */
type Part = Pick<
  Occurrence,
  'actor' | 'occurredAt' | 'title' | 'state' | 'url' | 'text' | 'sha'
> & {
  number: number;
};

/** Raised and caught inside this module; it carries a field path and never payload text. */
class Malformed extends Error {
  constructor(readonly field: string) {
    super('malformed');
  }
}

function isRecord(value: unknown): value is Body {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function record(parent: Body, key: string, path: string): Body {
  const value = parent[key];
  if (!isRecord(value)) {
    throw new Malformed(path);
  }
  return value;
}

function id(parent: Body, key: string, path: string): number {
  const value = parent[key];
  if (!isId(value)) {
    throw new Malformed(path);
  }
  return value;
}

function time(parent: Body, key: string, path: string): number {
  const value = parent[key];
  const at = typeof value === 'string' && TIMESTAMP.test(value) ? Date.parse(value) : NaN;
  if (!Number.isSafeInteger(at) || at < 0) {
    throw new Malformed(path);
  }
  return at;
}

/** A lower-cased enumeration value such as a verdict, or `undefined` for anything else. */
function word(value: unknown): string | undefined {
  return typeof value === 'string' && WORD.test(value) ? value.toLowerCase() : undefined;
}

function sha(value: unknown): string | undefined {
  return typeof value === 'string' && SHA.test(value) ? value.toLowerCase() : undefined;
}

function actor(parent: Body, key: string, path: string, association?: unknown): Actor {
  const user = record(parent, key, path);
  const login = line(user.login, LOGIN);
  if (login == null) {
    throw new Malformed(`${path}.login`);
  }
  if (typeof user.type !== 'string') {
    throw new Malformed(`${path}.type`);
  }
  const relation = word(association);
  return {
    id: id(user, 'id', `${path}.id`),
    login,
    bot: user.type === 'Bot',
    ...(relation != null && { association: relation }),
  };
}

function review(body: Body, limits: Limits): Part[] {
  const submitted = record(body, 'review', 'review');
  const pull = record(body, 'pull_request', 'pull_request');
  const state = word(submitted.state);
  if (state == null) {
    throw new Malformed('review.state');
  }
  return [
    {
      number: id(pull, 'number', 'pull_request.number'),
      actor: actor(submitted, 'user', 'review.user', submitted.author_association),
      occurredAt: time(submitted, 'submitted_at', 'review.submitted_at'),
      title: line(pull.title, TITLE),
      state,
      url: link(submitted.html_url),
      text: excerpt(submitted.body, limits.excerpt),
      sha: sha(submitted.commit_id),
    },
  ];
}

function reviewComment(body: Body, limits: Limits): Part[] {
  const comment = record(body, 'comment', 'comment');
  const pull = record(body, 'pull_request', 'pull_request');
  return [
    {
      number: id(pull, 'number', 'pull_request.number'),
      actor: actor(comment, 'user', 'comment.user', comment.author_association),
      occurredAt: time(comment, 'created_at', 'comment.created_at'),
      title: line(pull.title, TITLE),
      url: link(comment.html_url),
      text: excerpt(comment.body, limits.excerpt),
      sha: sha(comment.commit_id),
    },
  ];
}

/** GitHub sends a pull request's conversation comments as issue comments. */
function issueComment(body: Body, limits: Limits): Part[] {
  const issue = record(body, 'issue', 'issue');
  if (!isRecord(issue.pull_request)) {
    return [];
  }
  const comment = record(body, 'comment', 'comment');
  return [
    {
      number: id(issue, 'number', 'issue.number'),
      actor: actor(comment, 'user', 'comment.user', comment.author_association),
      occurredAt: time(comment, 'created_at', 'comment.created_at'),
      title: line(issue.title, TITLE),
      url: link(comment.html_url),
      text: excerpt(comment.body, limits.excerpt),
    },
  ];
}

/** The pull request's page, built from the repository's own address. */
function page(repository: Body, number: number): string | undefined {
  const home = link(repository.html_url);
  if (home == null || home.includes('#')) {
    return undefined;
  }
  return `${home.endsWith('/') ? home.slice(0, -1) : home}/pull/${number}`;
}

/**
 * A check suite names the pull requests its commit heads. Only those opened against the
 * delivering repository count: a number means nothing in another repository, and GitHub
 * lists none at all when the branch lives in a fork. Reading stops at `limits.fanout` of them.
 */
function checkSuite(body: Body, limits: Limits): Part[] {
  const suite = record(body, 'check_suite', 'check_suite');
  const pulls = suite.pull_requests;
  if (!Array.isArray(pulls)) {
    throw new Malformed('check_suite.pull_requests');
  }
  const repository = record(body, 'repository', 'repository');
  const home = id(repository, 'id', 'repository.id');
  const numbers = new Set<number>();
  for (const pull of pulls) {
    if (numbers.size >= limits.fanout) {
      break;
    }
    if (!isRecord(pull)) {
      throw new Malformed('check_suite.pull_requests');
    }
    const base = record(
      record(pull, 'base', 'check_suite.pull_requests.base'),
      'repo',
      'check_suite.pull_requests.base.repo',
    );
    const number = id(pull, 'number', 'check_suite.pull_requests.number');
    if (id(base, 'id', 'check_suite.pull_requests.base.repo.id') === home) {
      numbers.add(number);
    }
  }
  if (numbers.size === 0) {
    return [];
  }
  const shared = {
    actor: actor(body, 'sender', 'sender'),
    occurredAt: time(suite, 'updated_at', 'check_suite.updated_at'),
    state: word(suite.conclusion),
    sha: sha(suite.head_sha),
  };
  return Array.from(numbers, (number) => ({ ...shared, number, url: page(repository, number) }));
}

function closed(body: Body): Part[] {
  const pull = record(body, 'pull_request', 'pull_request');
  if (typeof pull.merged !== 'boolean') {
    throw new Malformed('pull_request.merged');
  }
  return [
    {
      number: id(pull, 'number', 'pull_request.number'),
      actor: actor(body, 'sender', 'sender'),
      occurredAt: time(pull, 'closed_at', 'pull_request.closed_at'),
      title: line(pull.title, TITLE),
      state: pull.merged ? 'merged' : 'closed',
      url: link(pull.html_url),
    },
  ];
}

const readers: Readonly<Record<AgentEventType, (body: Body, limits: Limits) => Part[]>> = {
  'github.pull_request_review.submitted': review,
  'github.pull_request_review_comment.created': reviewComment,
  'github.issue_comment.created': issueComment,
  'github.check_suite.completed': checkSuite,
  'github.pull_request.closed': closed,
};

/** `provider.event` to its listed actions, so an unlisted action is told from an unlisted event. */
const listed = new Map<string, Map<string, AgentEventType>>();
for (const type of AGENT_EVENT_TYPES) {
  const { provider, event, action } = catalog[type];
  const key = `${provider}.${event}`;
  const actions = listed.get(key) ?? new Map<string, AgentEventType>();
  actions.set(action, type);
  listed.set(key, actions);
}

/** The repository and installation a delivery came from, the same for each of its occurrences. */
function origin(body: Body): Pick<Occurrence, 'repo' | 'installation'> {
  const repository = record(body, 'repository', 'repository');
  const name = repository.full_name;
  if (typeof name !== 'string' || !REPOSITORY.test(name)) {
    throw new Malformed('repository.full_name');
  }
  const installation = isRecord(body.installation) ? body.installation.id : undefined;
  return {
    repo: { id: id(repository, 'id', 'repository.id'), name },
    ...(isId(installation) && { installation }),
  };
}

function occurrence(
  type: AgentEventType,
  from: Pick<Occurrence, 'repo' | 'installation'>,
  part: Part,
): Occurrence {
  const { number, actor: by, occurredAt, title, state, url, text, sha: commit } = part;
  return {
    type,
    item: { provider: 'github', kind: 'pr', repo: from.repo.id, number },
    actor: by,
    ...from,
    occurredAt,
    ...(title != null && { title }),
    ...(state != null && { state }),
    ...(url != null && { url }),
    ...(text != null && { text }),
    ...(commit != null && { sha: commit }),
  };
}

/**
 * Reads one verified delivery: the provider's name for the event (GitHub's `X-GitHub-Event`
 * header) and its parsed JSON body. A check suite that heads several pull requests yields one
 * occurrence for each; everything else yields one. `limits` defaults to `LIMITS`.
 *
 * It never throws for what a JSON payload contains and never returns payload text in an error,
 * so a failure is safe to log. The caller must have verified the delivery's signature first:
 * nothing here can tell a forged payload from a real one.
 */
export function normalize(
  provider: AgentEventProvider,
  event: string,
  body: unknown,
  limits: Limits = LIMITS,
): Outcome {
  const actions = listed.get(`${provider}.${event}`);
  if (actions == null) {
    return { ok: false, error: { code: 'ignored', reason: 'event' } };
  }
  if (!isRecord(body)) {
    return { ok: false, error: { code: 'malformed', field: 'body' } };
  }
  if (typeof body.action !== 'string') {
    return { ok: false, error: { code: 'malformed', field: 'action' } };
  }
  const type = actions.get(body.action);
  if (type == null) {
    return { ok: false, error: { code: 'ignored', reason: 'action' } };
  }
  try {
    const parts = readers[type](body, limits);
    if (parts.length === 0) {
      return { ok: false, error: { code: 'ignored', reason: 'item' } };
    }
    const from = origin(body);
    return { ok: true, value: parts.map((part) => occurrence(type, from, part)) };
  } catch (error) {
    if (error instanceof Malformed) {
      return { ok: false, error: { code: 'malformed', field: error.field } };
    }
    throw error;
  }
}
