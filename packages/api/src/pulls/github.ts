import type {
  PullRequestChecks,
  PullRequestMergeable,
  PullRequestState,
  TConversationPullRequest,
} from 'librechat-data-provider';
import type { PullRequestSource } from './types';
import { PullRequestSourceError } from './types';

const GITHUB_API_BASE = 'https://api.github.com';
const REQUEST_TIMEOUT_MS = 10_000;
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
    (value.mergeable !== null && typeof value.mergeable !== 'boolean')
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
  };
}

function parseListItem(value: unknown): { number: number; state: string; sha: string } {
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

function parseCheckRuns(value: unknown): GitHubCheckRun[] {
  if (!isRecord(value) || !Array.isArray(value.check_runs)) {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  return value.check_runs.map((run) => {
    if (!isRecord(run) || typeof run.status !== 'string') {
      throw new PullRequestSourceError('UPSTREAM_ERROR');
    }
    return {
      status: run.status,
      conclusion: typeof run.conclusion === 'string' ? run.conclusion : null,
    };
  });
}

/** A failed check outranks one still running, so the header turns red as soon as it is known. */
export function summarizeChecks(runs: readonly GitHubCheckRun[]): PullRequestChecks {
  if (runs.length === 0) return 'none';
  if (runs.some((run) => run.conclusion != null && FAILING_CONCLUSIONS.has(run.conclusion))) {
    return 'failing';
  }
  if (runs.some((run) => run.status !== 'completed')) return 'running';
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
    checks: summarizeChecks(runs),
  };
}

function isRateLimited(response: Response): boolean {
  return (
    response.status === 429 ||
    (response.status === 403 &&
      (response.headers.get('x-ratelimit-remaining') === '0' ||
        response.headers.get('retry-after') != null))
  );
}

/**
 * Reads pull requests through GitHub's REST API with a token the caller supplies. Only the
 * decision (absent, rate limited, failed) leaves this module; response bodies and error text
 * never do.
 */
/** `.` and `..` match the character class but would rewrite the API path. */
const isPathSegment = (value: string): boolean => value !== '.' && value !== '..';

export function createGitHubPullRequestSource({
  fetchFn = fetch,
  apiBase = GITHUB_API_BASE,
}: { fetchFn?: PullRequestFetch; apiBase?: string } = {}): PullRequestSource {
  async function getJson(pathname: string, token: string): Promise<unknown | null> {
    let response: Response;
    try {
      response = await fetchFn(`${apiBase}${pathname}`, {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${token}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'LibreChat-Pull-Requests',
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
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
    if (isRateLimited(response)) throw new PullRequestSourceError('RATE_LIMITED');
    /** A repository the token cannot see is indistinguishable from one without pull requests. */
    if (response.status === 404) return null;
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }

  return {
    async find({ repo, branch, token }) {
      const match = REPO_PATTERN.exec(repo);
      if (match == null || branch.length === 0) return null;
      const [, owner, name] = match;
      if (!isPathSegment(owner) || !isPathSegment(name)) return null;
      const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
      const head = encodeURIComponent(`${owner}:${branch}`);
      const listed = await getJson(
        `${base}/pulls?state=all&sort=updated&direction=desc&per_page=10&head=${head}`,
        token,
      );
      if (listed == null) return null;
      if (!Array.isArray(listed)) throw new PullRequestSourceError('UPSTREAM_ERROR');
      const candidates = listed.map(parseListItem);
      const chosen = candidates.find((item) => item.state === 'open') ?? candidates[0];
      if (chosen == null) return null;

      const [pull, runs] = await Promise.all([
        getJson(`${base}/pulls/${chosen.number}`, token),
        getJson(`${base}/commits/${chosen.sha}/check-runs?per_page=100`, token),
      ]);
      if (pull == null) return null;
      return toConversationPullRequest(parsePull(pull), runs == null ? [] : parseCheckRuns(runs));
    },
  };
}
