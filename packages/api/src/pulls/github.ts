import type {
  PullRequestChecks,
  PullRequestMergeable,
  PullRequestState,
  TConversationPullRequest,
} from 'librechat-data-provider';
import type { PullRequestSource } from './types';
import { PullRequestSourceError } from './types';

const GITHUB_API_BASE = 'https://api.github.com';
/** Defaults for the operator bounds in `endpoints.agents.pullRequests`. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_LOOKUP_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CHECK_RUN_PAGES = 10;
const CHECK_RUN_PAGE_SIZE = 100;
const DEFAULT_MAX_CANDIDATE_PULL_REQUESTS = 10;
const DEFAULT_MAX_HEAD_COMPARISONS = 3;
/**
 * Comparing `recorded...candidate`: `ahead` means the candidate builds on the recorded commit and
 * `identical` that it is the recorded commit. `behind` means the candidate does not contain it
 * (the recorded commit is newer), and `diverged` that the histories split, so neither matches.
 */
const CONTAINS_RECORDED_STATUSES = new Set(['ahead', 'identical']);
const COMMIT_ID = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_TITLE_LENGTH = 256;
const REPO_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;
const FAILING_CONCLUSIONS = new Set([
  'failure',
  'timed_out',
  'cancelled',
  'action_required',
  'startup_failure',
  'stale',
]);

/** The only part of `fetch` this module calls, so any compatible client can be injected. */
export type PullRequestFetch = (input: string, init?: RequestInit) => Promise<Response>;

type GitHubPull = {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed';
  merged: boolean;
  draft: boolean;
  additions: number;
  deletions: number;
  mergeable: boolean | null;
  /** The head this detail describes; the check runs are read for this same commit. */
  headSha: string;
};

type GitHubCheckRun = { status: string; conclusion: string | null };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const isCount = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** The URL ends up in an href, so only a plain https github.com page is accepted. */
function isGitHubPageUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'github.com';
  } catch {
    return false;
  }
}

function parsePull(value: unknown): GitHubPull {
  if (
    !isRecord(value) ||
    !isCount(value.number) ||
    typeof value.title !== 'string' ||
    !isGitHubPageUrl(value.html_url) ||
    (value.state !== 'open' && value.state !== 'closed') ||
    typeof value.merged !== 'boolean' ||
    typeof value.draft !== 'boolean' ||
    !isCount(value.additions) ||
    !isCount(value.deletions) ||
    (value.mergeable !== null && typeof value.mergeable !== 'boolean') ||
    !isRecord(value.head) ||
    typeof value.head.sha !== 'string' ||
    !COMMIT_ID.test(value.head.sha)
  ) {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  return {
    number: value.number,
    title: value.title,
    url: value.html_url,
    state: value.state,
    merged: value.merged,
    draft: value.draft,
    additions: value.additions,
    deletions: value.deletions,
    mergeable: value.mergeable,
    headSha: value.head.sha,
  };
}

type ListItem = { number: number; state: string; sha: string };

function parseListItem(value: unknown): ListItem {
  if (
    !isRecord(value) ||
    !isCount(value.number) ||
    typeof value.state !== 'string' ||
    !isRecord(value.head) ||
    typeof value.head.sha !== 'string' ||
    !/^[a-f0-9]{40,64}$/.test(value.head.sha)
  ) {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  return { number: value.number, state: value.state, sha: value.head.sha };
}

type CheckRunPage = { runs: GitHubCheckRun[]; total?: number };

function parseCheckRuns(value: unknown): CheckRunPage {
  if (!isRecord(value) || !Array.isArray(value.check_runs)) {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  const runs = value.check_runs.map((run) => {
    if (!isRecord(run) || typeof run.status !== 'string') {
      throw new PullRequestSourceError('UPSTREAM_ERROR');
    }
    return {
      status: run.status,
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
    };
  });
  return { runs, ...(isCount(value.total_count) ? { total: value.total_count } : {}) };
}

/**
 * A failed check outranks one still running, so the header turns red as soon as it is known.
 * An `incomplete` rollup (more runs than were read) is never reported as passing.
 */
export function summarizeChecks(
  runs: readonly GitHubCheckRun[],
  incomplete = false,
): PullRequestChecks {
  if (runs.length === 0 && !incomplete) return 'none';
  if (runs.some((run) => run.conclusion != null && FAILING_CONCLUSIONS.has(run.conclusion))) {
    return 'failing';
  }
  if (incomplete || runs.some((run) => run.status !== 'completed')) return 'running';
  return 'passing';
}

function summarizeState(pull: GitHubPull): PullRequestState {
  return pull.merged ? 'merged' : pull.state;
}

/** Conflict state only means something while the pull request is open. */
function summarizeMergeable(pull: GitHubPull): PullRequestMergeable {
  if (summarizeState(pull) !== 'open' || pull.mergeable == null) return 'unknown';
  return pull.mergeable ? 'clean' : 'conflicting';
}

export function toConversationPullRequest(
  pull: GitHubPull,
  runs: readonly GitHubCheckRun[],
  incomplete = false,
): TConversationPullRequest {
  return {
    number: pull.number,
    title: pull.title.slice(0, MAX_TITLE_LENGTH),
    url: pull.url,
    additions: pull.additions,
    deletions: pull.deletions,
    state: summarizeState(pull),
    isDraft: pull.draft,
    mergeable: summarizeMergeable(pull),
    checks: summarizeChecks(runs, incomplete),
  };
}

/** GitHub asks for at least a minute when a secondary limit names no wait. */
const SECONDARY_LIMIT_WAIT_MS = 60_000;
const SECONDARY_LIMIT_MESSAGE = /secondary rate limit|abuse detection/i;
const MAX_ERROR_BODY_CHARS = 2_000;

function isRateLimited(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.get('retry-after') != null))
  );
}

/**
 * A secondary limit can arrive as a 403 with neither limiting header, told apart only by its
 * message. The body is read bounded and only matched, never stored or returned.
 */
async function isSecondaryLimit(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const text = (await response.text()).slice(0, MAX_ERROR_BODY_CHARS);
    return SECONDARY_LIMIT_MESSAGE.test(text);
  } catch {
    return false;
  }
}

/** How long GitHub asked callers to wait: `retry-after` seconds, else the quota reset time. */
function retryAfterMs(response: Response): number | undefined {
  const retryAfter = Number(response.headers.get('retry-after'));
  if (response.headers.get('retry-after') != null && Number.isFinite(retryAfter)) {
    return Math.max(0, retryAfter * 1000);
  }
  const reset = Number(response.headers.get('x-ratelimit-reset'));
  if (response.headers.get('x-ratelimit-reset') != null && Number.isFinite(reset)) {
    return Math.max(0, reset * 1000 - Date.now());
  }
  return undefined;
}

/**
 * Reads pull requests through GitHub's REST API with a token the caller supplies. Only the
 * decision (absent, rate limited, failed) leaves this module; response bodies and error text
 * never do.
 */
/** `.` and `..` match the character class but would rewrite the API path. */
const isPathSegment = (value: string): boolean => value !== '.' && value !== '..';

export function createGitHubPullRequestSource({
  fetchFn,
  apiBase = GITHUB_API_BASE,
}: {
  /** The deployment's HTTP client, so proxying and instrumentation are decided by the caller. */
  fetchFn: PullRequestFetch;
  apiBase?: string;
}): PullRequestSource {
  /** One lookup's credential and deadlines, shared by every request it makes. */
  type Lookup = {
    token: string;
    requestTimeoutMs: number;
    /** Aborts when the whole lookup runs out of time. */
    deadline: AbortSignal;
    maxCheckRunPages: number;
    maxCandidatePullRequests: number;
    maxHeadComparisons: number;
  };

  async function getJson(
    pathname: string,
    lookup: Lookup,
    /** Statuses that mean "nothing there" for this request, besides 404. */
    absent: readonly number[] = [],
  ): Promise<unknown | null> {
    let response: Response;
    try {
      response = await fetchFn(`${apiBase}${pathname}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${lookup.token}`,
          'X-GitHub-Api-Version': '2022-11-28',
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
    if (isRateLimited(response)) {
      throw new PullRequestSourceError('RATE_LIMITED', retryAfterMs(response));
    }
    if (await isSecondaryLimit(response)) {
      throw new PullRequestSourceError('RATE_LIMITED', SECONDARY_LIMIT_WAIT_MS);
    }
    /** A repository the token cannot see is indistinguishable from one without pull requests. */
    if (response.status === 404 || absent.includes(response.status)) return null;
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }

  /** Reads every page up to a bound, so a failure on a later page still shows. */
  async function readCheckRuns(
    pathname: string,
    lookup: Lookup,
  ): Promise<{ runs: GitHubCheckRun[]; incomplete: boolean }> {
    const runs: GitHubCheckRun[] = [];
    for (let page = 1; page <= lookup.maxCheckRunPages; page++) {
      const body = await getJson(
        `${pathname}?per_page=${CHECK_RUN_PAGE_SIZE}&page=${page}`,
        lookup,
      );
      if (body == null) return { runs, incomplete: false };
      const parsed = parseCheckRuns(body);
      runs.push(...parsed.runs);
      const done =
        parsed.total != null
          ? runs.length >= parsed.total || parsed.runs.length === 0
          : parsed.runs.length < CHECK_RUN_PAGE_SIZE;
      if (done) return { runs, incomplete: false };
    }
    return { runs, incomplete: true };
  }

  return {
    async find({ repo, branch, head: recordedHead, token, limits }) {
      const lookup: Lookup = {
        token,
        requestTimeoutMs: limits?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        deadline: AbortSignal.timeout(limits?.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS),
        maxCheckRunPages: limits?.maxCheckRunPages ?? DEFAULT_MAX_CHECK_RUN_PAGES,
        maxCandidatePullRequests:
          limits?.maxCandidatePullRequests ?? DEFAULT_MAX_CANDIDATE_PULL_REQUESTS,
        maxHeadComparisons: limits?.maxHeadComparisons ?? DEFAULT_MAX_HEAD_COMPARISONS,
      };
      const match = REPO_PATTERN.exec(repo);
      if (match == null || branch.length === 0) return null;
      const [, owner, name] = match;
      if (!isPathSegment(owner) || !isPathSegment(name)) return null;
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
      const headFilter = encodeURIComponent(`${owner}:${branch}`);
      /** `undefined`: the repository is not visible. An empty list: it is, and nothing matched. */
      const listPulls = async (state: 'open' | 'closed', perPage: number) => {
        const listed = await getJson(
          `${base}/pulls?state=${state}&sort=updated&direction=desc&per_page=${perPage}&head=${headFilter}`,
          lookup,
        );
        if (listed == null) return undefined;
        if (!Array.isArray(listed)) throw new PullRequestSourceError('UPSTREAM_ERROR');
        return listed.map(parseListItem);
      };
      const recorded =
        typeof recordedHead === 'string' && COMMIT_ID.test(recordedHead) ? recordedHead : undefined;
      let comparisons = 0;
      /**
       * A branch name can be deleted and reused, so with a recorded commit a pull request counts
       * only when its head is that commit or builds on it. A commit GitHub no longer knows is no
       * match, and both the candidates listed and the comparisons made are bounded by config.
       */
      /** Every comparison, the first match and the revalidation of a moved head alike, spends the
       *  same configured budget. */
      const contains = async (headSha: string): Promise<boolean> => {
        if (recorded == null || headSha === recorded) return true;
        if (comparisons >= lookup.maxHeadComparisons) return false;
        comparisons += 1;
        const comparison = await getJson(`${base}/compare/${recorded}...${headSha}`, lookup);
        if (comparison == null) return false;
        if (!isRecord(comparison) || typeof comparison.status !== 'string') {
          throw new PullRequestSourceError('UPSTREAM_ERROR');
        }
        return CONTAINS_RECORDED_STATUSES.has(comparison.status);
      };
      const matches = (candidate: ListItem): Promise<boolean> => contains(candidate.sha);
      const choose = async (candidates: ListItem[]): Promise<ListItem | null> => {
        for (const candidate of candidates) {
          if (await matches(candidate)) return candidate;
        }
        return null;
      };
      /** Open first on its own, so closed history on a reused branch name cannot hide it. */
      const open = await listPulls('open', lookup.maxCandidatePullRequests);
      if (open === undefined) return null;
      /**
       * The head filter names the repository's own owner, so a pull request from a fork is not in
       * these lists. The recorded commit finds it instead: GitHub lists the pull requests that
       * carry a commit whatever fork they come from, and the branch name narrows them.
       */
      const forkCandidates = async (): Promise<ListItem[]> => {
        if (recorded == null) return [];
        const found = await getJson(
          `${base}/commits/${recorded}/pulls?per_page=${lookup.maxCandidatePullRequests}`,
          lookup,
          [422],
        );
        if (found == null) return [];
        if (!Array.isArray(found)) throw new PullRequestSourceError('UPSTREAM_ERROR');
        return found
          .filter((item) => isRecord(item) && isRecord(item.head) && item.head.ref === branch)
          .map(parseListItem)
          .sort((a, b) => Number(a.state !== 'open') - Number(b.state !== 'open'));
      };
      const chosen =
        (await choose(open)) ??
        (await choose(
          (await listPulls('closed', recorded == null ? 1 : lookup.maxCandidatePullRequests)) ?? [],
        )) ??
        (await choose(await forkCandidates()));
      if (chosen == null) return null;

      /**
       * The detail comes first and its head decides which commit's checks are read. Listing,
       * detail and checks are separate requests, so a push between them could otherwise pair
       * today's line counts and mergeability with yesterday's checks.
       */
      const detail = await getJson(`${base}/pulls/${chosen.number}`, lookup);
      if (detail == null) return null;
      const pull = parsePull(detail);
      /** A push between the list and the detail can move the head off the recorded commit. */
      if (pull.headSha !== chosen.sha && !(await contains(pull.headSha))) return null;
      const checks = await readCheckRuns(`${base}/commits/${pull.headSha}/check-runs`, lookup);
      return toConversationPullRequest(pull, checks.runs, checks.incomplete);
    },
  };
}
