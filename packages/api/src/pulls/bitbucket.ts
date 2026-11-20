import type {
  PullRequestChecks,
  PullRequestState,
  TConversationPullRequest,
} from 'librechat-data-provider';
import type { PullRequestFetch } from './shared';
import type { PullRequestSource } from './types';
import {
  isCount,
  isRecord,
  COMMIT_ID,
  isPageUrl,
  retryAfterMs,
  isPathSegment,
  MAX_TITLE_LENGTH,
  DEFAULT_LOOKUP_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_MAX_CANDIDATE_PAGES,
  DEFAULT_MAX_HEAD_COMPARISONS,
  DEFAULT_MAX_CANDIDATE_PULL_REQUESTS,
} from './shared';
import { logDiscoveryDiagnostic } from './diagnostics';
import { PullRequestSourceError } from './types';

export const BITBUCKET_HOST = 'bitbucket.org';
/** Every request goes under this prefix; a `next` link elsewhere is never followed. */
const API_ROOT = 'https://api.bitbucket.org/2.0/';
/** `workspace/repo_slug`: Bitbucket Cloud has no nested groups. */
const REPOSITORY_PATH = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
/** Bitbucket abbreviates commits in pull requests (12 characters today), so any length is taken. */
const COMMIT_HASH = /^[a-f0-9]{7,64}$/;
/** The shortest prefix two commits are compared by. */
const MIN_HASH_LENGTH = 7;
/** The most pull requests Bitbucket returns per page; a larger `pagelen` is not honored. */
const MAX_PAGE_LENGTH = 50;
const DEFAULT_MAX_PAGES = 10;
const OPEN_STATES = ['OPEN'] as const;
const CLOSED_STATES = ['MERGED', 'DECLINED', 'SUPERSEDED'] as const;
const STATES = [...OPEN_STATES, ...CLOSED_STATES];
const FAILING_STATUSES = new Set(['FAILED', 'STOPPED']);

type BitbucketPullRequest = {
  id: number;
  title: string;
  url: string;
  state: PullRequestState;
  draft: boolean;
  /** The abbreviated head commit. */
  hash: string;
  /** The branch the pull request merges from, in whichever repository it lives. */
  sourceBranch: string | null;
  /** Whether the source branch lives in another repository (a fork, or one since deleted). */
  fromFork: boolean;
};

type ListItem = { id: number; state: string; hash: string; fromFork: boolean };

/** A pull request whose source commit is gone (a deleted branch, a collected commit) proves nothing. */
type Parsed<T extends { hash: string }> = Omit<T, 'hash'> & { hash: string | null };

/** Two commit hashes, either possibly abbreviated, name the same commit. */
export function isSameCommit(a: string, b: string): boolean {
  const length = Math.min(a.length, b.length);
  return length >= MIN_HASH_LENGTH && a.slice(0, length) === b.slice(0, length);
}

/**
 * A failed or stopped status outranks one in progress; only every status successful is passing.
 * An `incomplete` read (more statuses than were read) is never reported as passing.
 */
export function summarizeStatuses(
  states: readonly string[],
  incomplete = false,
): PullRequestChecks {
  if (states.length === 0 && !incomplete) return 'none';
  if (states.some((state) => FAILING_STATUSES.has(state))) return 'failing';
  if (incomplete || states.some((state) => state !== 'SUCCESSFUL')) return 'running';
  return 'passing';
}

function summarizeState(state: string): PullRequestState {
  if (state === 'OPEN') return 'open';
  return state === 'MERGED' ? 'merged' : 'closed';
}

function parseCommon(value: unknown, repo: string) {
  if (
    !isRecord(value) ||
    !isCount(value.id) ||
    typeof value.state !== 'string' ||
    !(STATES as readonly string[]).includes(value.state) ||
    !isRecord(value.source)
  ) {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  const { source } = value;
  const commit = isRecord(source.commit) ? source.commit.hash : null;
  if (commit != null && (typeof commit !== 'string' || !COMMIT_HASH.test(commit))) {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  const branch = isRecord(source.branch) ? source.branch.name : null;
  /** A deleted fork leaves no source repository, which is as unproven as any other fork. */
  const fullName = isRecord(source.repository) ? source.repository.full_name : null;
  return {
    value,
    id: value.id,
    state: value.state,
    hash: typeof commit === 'string' ? commit : null,
    sourceBranch: typeof branch === 'string' ? branch : null,
    fromFork: typeof fullName !== 'string' || fullName.toLowerCase() !== repo.toLowerCase(),
  };
}

function parsePullRequest(value: unknown, repo: string): Parsed<BitbucketPullRequest> {
  const common = parseCommon(value, repo);
  const links = common.value.links;
  const html = isRecord(links) && isRecord(links.html) ? links.html.href : null;
  if (typeof common.value.title !== 'string' || !isPageUrl(html, BITBUCKET_HOST)) {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  return {
    id: common.id,
    title: common.value.title,
    url: html,
    state: summarizeState(common.state),
    draft: common.value.draft === true,
    hash: common.hash,
    sourceBranch: common.sourceBranch,
    fromFork: common.fromFork,
  };
}

function parseListItem(value: unknown, repo: string): Parsed<ListItem> {
  const { id, state, hash, fromFork } = parseCommon(value, repo);
  return { id, state, hash, fromFork };
}

/** One page of a paginated collection: its values and the validated next page, if any. */
function parsePage(value: unknown): { values: unknown[]; next: string | null } {
  if (!isRecord(value) || !Array.isArray(value.values)) {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  if (value.next == null) return { values: value.values, next: null };
  if (typeof value.next !== 'string') throw new PullRequestSourceError('UPSTREAM_ERROR');
  let next: URL;
  try {
    next = new URL(value.next);
  } catch {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  /** The token goes with the request, so a link off the API is a failure, never a fetch. */
  if (!next.href.startsWith(API_ROOT)) throw new PullRequestSourceError('UPSTREAM_ERROR');
  return { values: value.values, next: next.href };
}

/** The commit a status was reported for, when the status says. */
function statusCommit(value: Record<string, unknown>): string | null {
  if (isRecord(value.commit) && typeof value.commit.hash === 'string') return value.commit.hash;
  const links = value.links;
  const href = isRecord(links) && isRecord(links.commit) ? links.commit.href : null;
  if (typeof href !== 'string') return null;
  return /\/commit\/([a-f0-9]{7,64})$/.exec(href)?.[1] ?? null;
}

const isComplete = <T extends { hash: string | null }>(item: T): item is T & { hash: string } =>
  item.hash != null;

/** BBQL string literal: a backslash or a double quote inside it is escaped with a backslash. */
const bbqlString = (value: string): string => `"${value.replace(/[\\"]/g, '\\$&')}"`;

/**
 * Reads pull requests through Bitbucket Cloud's REST API (2.0) with a token the caller supplies:
 * a repository, project or workspace access token, or an OAuth access token, all sent as a bearer
 * token. Only the decision (absent, rate limited, failed) leaves this module; response bodies and
 * error text never do.
 */
export function createBitbucketPullRequestSource({
  fetchFn,
}: {
  /** The deployment's HTTP client, so proxying and instrumentation are decided by the caller. */
  fetchFn: PullRequestFetch;
}): PullRequestSource {
  type Lookup = {
    token: string;
    requestTimeoutMs: number;
    deadline: AbortSignal;
    maxCheckRunPages: number;
    maxCandidatePullRequests: number;
    maxHeadComparisons: number;
    maxCandidatePages: number;
  };

  async function request(
    url: string,
    lookup: Lookup,
    /** Statuses that mean "nothing there" for this request, besides 404. */
    absent: readonly number[] = [],
  ): Promise<unknown | null> {
    let response: Response;
    try {
      response = await fetchFn(url, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${lookup.token}`,
          'User-Agent': 'LibreChat-Pull-Requests',
        },
        signal: AbortSignal.any([AbortSignal.timeout(lookup.requestTimeoutMs), lookup.deadline]),
      });
    } catch {
      throw new PullRequestSourceError('UPSTREAM_ERROR');
    }
    if (response.ok) {
      try {
        return await response.json();
      } catch {
        throw new PullRequestSourceError('UPSTREAM_ERROR');
      }
    }
    /** Bitbucket sends no reset time with a rate limit, at most a `retry-after`. */
    if (response.status === 429) {
      throw new PullRequestSourceError('RATE_LIMITED', retryAfterMs(response, 'retry-after'));
    }
    /** A repository the token cannot see is indistinguishable from one without pull requests. */
    if (response.status === 404 || absent.includes(response.status)) return null;
    /** The provider no longer accepts the token: revoked, or expired without a refresh. */
    if (response.status === 401) throw new PullRequestSourceError('CREDENTIAL_REJECTED');
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }

  /**
   * Reads every page of a collection up to a bound, so a failure on a later page still shows.
   * The pull request was read a moment ago, so a 404 here is one that vanished, not an empty list.
   */
  async function readPages(
    url: string,
    lookup: Lookup,
  ): Promise<{ values: unknown[]; incomplete: boolean }> {
    const values: unknown[] = [];
    let next: string | null = url;
    for (let page = 0; page < lookup.maxCheckRunPages && next != null; page++) {
      const body = await request(next, lookup);
      if (body == null) throw new PullRequestSourceError('UPSTREAM_ERROR');
      const parsed = parsePage(body);
      values.push(...parsed.values);
      next = parsed.next;
    }
    return { values, incomplete: next != null };
  }

  return {
    async find({ repo, branch, head: recordedHead, pullRequest, token, limits }) {
      /** As on GitHub: a lane with a branch and no commit yet has nothing to match against. */
      if (recordedHead === null) return null;
      if (!REPOSITORY_PATH.test(repo) || !repo.split('/').every(isPathSegment)) return null;
      if (branch.length === 0) return null;
      const lookup: Lookup = {
        token,
        requestTimeoutMs: limits?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        deadline: AbortSignal.timeout(limits?.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS),
        maxCheckRunPages: limits?.maxCheckRunPages ?? DEFAULT_MAX_PAGES,
        maxCandidatePullRequests:
          limits?.maxCandidatePullRequests ?? DEFAULT_MAX_CANDIDATE_PULL_REQUESTS,
        maxHeadComparisons: limits?.maxHeadComparisons ?? DEFAULT_MAX_HEAD_COMPARISONS,
        maxCandidatePages: limits?.maxCandidatePages ?? DEFAULT_MAX_CANDIDATE_PAGES,
      };
      const [workspace, slug] = repo.split('/');
      const base = `${API_ROOT}repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(slug)}`;
      const getJson = (pathname: string, absent: readonly number[] = []) =>
        request(`${base}${pathname}`, lookup, absent);

      const recorded =
        typeof recordedHead === 'string' && COMMIT_ID.test(recordedHead) ? recordedHead : undefined;
      let comparisons = 0;
      /**
       * With a recorded commit a pull request counts only when its head is that commit or builds
       * on it: their merge base is the recorded commit. Every comparison spends the configured
       * budget, and a commit Bitbucket does not know is no match.
       */
      const contains = async (hash: string): Promise<boolean> => {
        if (recorded == null || recorded.startsWith(hash)) return true;
        if (comparisons >= lookup.maxHeadComparisons) {
          logDiscoveryDiagnostic('bitbucket', 'COMPARISON_LIMIT');
          return false;
        }
        comparisons += 1;
        const merged = await getJson(`/merge-base/${recorded}..${hash}`, [400]);
        if (merged == null) {
          logDiscoveryDiagnostic('bitbucket', 'COMPARISON_UNAVAILABLE');
          return false;
        }
        if (!isRecord(merged) || typeof merged.hash !== 'string') {
          throw new PullRequestSourceError('UPSTREAM_ERROR');
        }
        return isSameCommit(merged.hash, recorded);
      };
      /**
       * A branch name proves nothing for a fork (anyone can open `patch-1`), so a fork counts only
       * when it carries the recorded commit.
       */
      const matches = async (item: { hash: string; fromFork: boolean }): Promise<boolean> =>
        item.fromFork ? recorded != null && contains(item.hash) : contains(item.hash);

      const report = async (pull: BitbucketPullRequest): Promise<TConversationPullRequest> => {
        const path = `/pullrequests/${pull.id}`;
        const [diffstat, statuses] = await Promise.all([
          readPages(`${base}${path}/diffstat`, lookup),
          readPages(`${base}${path}/statuses`, lookup),
        ]);
        /**
         * Past the page bound the counts cover only the files read. They are still reported: a
         * pull request that large is better shown with a lower bound than with no size at all.
         */
        let additions = 0;
        let deletions = 0;
        for (const file of diffstat.values) {
          if (!isRecord(file)) throw new PullRequestSourceError('UPSTREAM_ERROR');
          const added = file.lines_added ?? 0;
          const removed = file.lines_removed ?? 0;
          if (!isCount(added) || !isCount(removed)) {
            throw new PullRequestSourceError('UPSTREAM_ERROR');
          }
          additions += added;
          deletions += removed;
        }
        const states: string[] = [];
        for (const status of statuses.values) {
          if (!isRecord(status) || typeof status.state !== 'string') {
            throw new PullRequestSourceError('UPSTREAM_ERROR');
          }
          /** A status of an earlier head says nothing about this one. */
          const commit = statusCommit(status);
          if (commit != null && !isSameCommit(commit, pull.hash)) continue;
          states.push(status.state);
        }
        return {
          number: pull.id,
          title: pull.title.slice(0, MAX_TITLE_LENGTH),
          url: pull.url,
          provider: 'bitbucket',
          additions,
          deletions,
          state: pull.state,
          isDraft: pull.draft,
          /** Bitbucket's API reports no conflict state for a pull request, only a diff. */
          mergeable: 'unknown',
          checks: summarizeStatuses(states, statuses.incomplete),
        };
      };

      /** A pull request the conversation's own output linked to is read directly. */
      if (pullRequest != null && Number.isSafeInteger(pullRequest) && pullRequest > 0) {
        const linked = await getJson(`/pullrequests/${pullRequest}`);
        if (linked != null) {
          const pull = parsePullRequest(linked, repo);
          if (isComplete(pull) && pull.sourceBranch === branch && (await matches(pull))) {
            return report(pull);
          }
        }
      }

      /**
       * A full page even without a recorded commit: the newest closed one may be a fork, which
       * cannot match, and must not hide an older one from the repository itself. Later pages come
       * from the `next` link Bitbucket returns, which is opaque, and only its absence ends the
       * list. `undefined`: the repository is not visible. An empty list: it is, and nothing matched.
       */
      const listAll = async (closed: boolean): Promise<ListItem[] | undefined> => {
        const states = closed ? CLOSED_STATES : OPEN_STATES;
        const pageLength = Math.min(Math.max(lookup.maxCandidatePullRequests, 1), MAX_PAGE_LENGTH);
        const filter = states.map((state) => `state = "${state}"`).join(' OR ');
        const query = new URLSearchParams({
          q: `source.branch.name = ${bbqlString(branch)} AND (${filter})`,
          sort: '-created_on',
          pagelen: String(pageLength),
        });
        /** The default list is open pull requests only. The `state` parameters lift that default
         *  and `q` names the same states, so either filter alone lists the same pull requests. */
        for (const state of states) query.append('state', state);
        const all: ListItem[] = [];
        let next: string | null = `${base}/pullrequests?${query.toString()}`;
        for (let page = 1; page <= lookup.maxCandidatePages && next != null; page++) {
          const listed = await request(next, lookup, []);
          if (listed == null) return page === 1 ? undefined : all;
          const parsed = parsePage(listed);
          all.push(...parsed.values.map((item) => parseListItem(item, repo)).filter(isComplete));
          next = parsed.next;
        }
        return all;
      };
      const choose = async (candidates: ListItem[]): Promise<ListItem | null> => {
        for (const candidate of candidates) {
          if (await matches(candidate)) return candidate;
        }
        return null;
      };

      /** Open first on its own, so closed history on a reused branch name cannot hide it. */
      const open = await listAll(false);
      if (open === undefined) return null;
      const chosen = (await choose(open)) ?? (await choose((await listAll(true)) ?? []));
      if (chosen == null) return null;

      const detail = await getJson(`/pullrequests/${chosen.id}`);
      if (detail == null) return null;
      const pull = parsePullRequest(detail, repo);
      /** The pull request may have changed between the list and the detail: its source branch,
       *  the repository it comes from, or a push that moved the head off the recorded commit. */
      if (!isComplete(pull) || pull.sourceBranch !== branch || pull.fromFork !== chosen.fromFork) {
        return null;
      }
      if (!isSameCommit(pull.hash, chosen.hash) && !(await matches(pull))) return null;
      return report(pull);
    },
  };
}
