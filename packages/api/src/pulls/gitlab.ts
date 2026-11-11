import type {
  PullRequestChecks,
  PullRequestMergeable,
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

export const DEFAULT_GITLAB_HOST = 'gitlab.com';
/** A project path: a namespace of one or more groups, then the project. */
const PROJECT_PATH = /^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+){1,19}$/;
const PASSING_PIPELINES = new Set(['success', 'skipped']);
const FAILING_PIPELINES = new Set(['failed', 'canceled']);
const DIFF_STATS_QUERY =
  'query($path: ID!, $iid: String!) { project(fullPath: $path) { mergeRequest(iid: $iid) { diffStatsSummary { additions deletions } } } }';

type GitLabMergeRequest = {
  iid: number;
  title: string;
  url: string;
  state: PullRequestState;
  draft: boolean;
  /** The head commit; the pipeline is trusted only when it ran for this commit. */
  sha: string;
  /** The branch the merge request merges from, in whichever project it lives; null if unsaid. */
  sourceBranch: string | null;
  /** Whether the source branch lives in a fork rather than the project itself. */
  fromFork: boolean;
  mergeable: PullRequestMergeable;
  checks: PullRequestChecks;
};

type ListItem = { iid: number; state: string; sha: string; fromFork: boolean };
type ListState = 'opened' | 'locked' | 'merged' | 'closed';

/** A failed or canceled pipeline outranks one still running; anything unfinished is running. */
export function summarizePipeline(status: string | null): PullRequestChecks {
  if (status == null) return 'none';
  if (FAILING_PIPELINES.has(status)) return 'failing';
  if (PASSING_PIPELINES.has(status)) return 'passing';
  return 'running';
}

function summarizeState(state: string): PullRequestState {
  if (state === 'merged') return 'merged';
  return state === 'opened' ? 'open' : 'closed';
}

/** Conflict state only means something while the merge request is open. */
function summarizeMergeable(value: Record<string, unknown>, state: PullRequestState) {
  if (state !== 'open') return 'unknown';
  if (value.has_conflicts === true || value.detailed_merge_status === 'conflict') {
    return 'conflicting';
  }
  if (value.detailed_merge_status === 'mergeable') return 'clean';
  return 'unknown';
}

const fromFork = (value: Record<string, unknown>): boolean =>
  value.source_project_id !== value.target_project_id;

function parseMergeRequest(value: unknown, host: string): GitLabMergeRequest {
  if (
    !isRecord(value) ||
    !isCount(value.iid) ||
    typeof value.title !== 'string' ||
    !isPageUrl(value.web_url, host) ||
    typeof value.state !== 'string' ||
    !['opened', 'closed', 'locked', 'merged'].includes(value.state) ||
    typeof value.sha !== 'string' ||
    !COMMIT_ID.test(value.sha) ||
    !isCount(value.source_project_id) ||
    !isCount(value.target_project_id)
  ) {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  const state = summarizeState(value.state);
  const pipeline = isRecord(value.head_pipeline) ? value.head_pipeline : null;
  /** A pipeline of an earlier head says nothing about this one. */
  const status =
    pipeline != null && pipeline.sha === value.sha && typeof pipeline.status === 'string'
      ? pipeline.status
      : null;
  return {
    iid: value.iid,
    title: value.title,
    url: value.web_url,
    state,
    draft: value.draft === true || value.work_in_progress === true,
    sha: value.sha,
    sourceBranch: typeof value.source_branch === 'string' ? value.source_branch : null,
    fromFork: fromFork(value),
    mergeable: summarizeMergeable(value, state),
    checks: summarizePipeline(status),
  };
}

function parseListItem(value: unknown): ListItem {
  if (
    !isRecord(value) ||
    !isCount(value.iid) ||
    typeof value.state !== 'string' ||
    typeof value.sha !== 'string' ||
    !COMMIT_ID.test(value.sha) ||
    !isCount(value.source_project_id) ||
    !isCount(value.target_project_id)
  ) {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  return { iid: value.iid, state: value.state, sha: value.sha, fromFork: fromFork(value) };
}

function parseDiffStats(value: unknown): { additions: number; deletions: number } {
  if (!isRecord(value) || value.errors != null || !isRecord(value.data)) {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  const project = value.data.project;
  const mergeRequest = isRecord(project) ? project.mergeRequest : null;
  if (!isRecord(mergeRequest)) throw new PullRequestSourceError('UPSTREAM_ERROR');
  /** GitLab has no summary for a merge request without changes. */
  const summary = mergeRequest.diffStatsSummary;
  if (summary == null) return { additions: 0, deletions: 0 };
  if (!isRecord(summary) || !isCount(summary.additions) || !isCount(summary.deletions)) {
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }
  return { additions: summary.additions, deletions: summary.deletions };
}

/**
 * Reads merge requests through GitLab's REST API (v4) on gitlab.com or a self-managed host, with a
 * token the caller supplies; line counts come from one GraphQL query, the only API that has them.
 * Only the decision (absent, rate limited, failed) leaves this module; response bodies and error
 * text never do.
 */
export function createGitLabPullRequestSource({
  fetchFn,
}: {
  /** The deployment's HTTP client, so proxying and instrumentation are decided by the caller. */
  fetchFn: PullRequestFetch;
}): PullRequestSource {
  type Lookup = {
    token: string;
    /** `https://{host}`; every request of the lookup goes there and nowhere else. */
    origin: string;
    requestTimeoutMs: number;
    deadline: AbortSignal;
    maxCandidatePullRequests: number;
    maxHeadComparisons: number;
    maxCandidatePages: number;
  };

  async function request(
    url: string,
    lookup: Lookup,
    init: { method?: string; body?: string } = {},
    /** Statuses that mean "nothing there" for this request, besides 404. */
    absent: readonly number[] = [],
  ): Promise<unknown | null> {
    let response: Response;
    try {
      response = await fetchFn(url, {
        ...init,
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${lookup.token}`,
          'User-Agent': 'LibreChat-Pull-Requests',
          ...(init.body != null ? { 'Content-Type': 'application/json' } : {}),
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
    if (response.status === 429) {
      throw new PullRequestSourceError('RATE_LIMITED', retryAfterMs(response, 'ratelimit-reset'));
    }
    /** A project the token cannot see is indistinguishable from one without merge requests. */
    if (response.status === 404 || absent.includes(response.status)) return null;
    /** The provider no longer accepts the token: revoked, or expired without a refresh. */
    if (response.status === 401) throw new PullRequestSourceError('CREDENTIAL_REJECTED');
    throw new PullRequestSourceError('UPSTREAM_ERROR');
  }

  return {
    async find({
      repo,
      branch,
      head: recordedHead,
      pullRequest,
      host = DEFAULT_GITLAB_HOST,
      token,
      limits,
    }) {
      /** As on GitHub: a lane with a branch and no commit yet has nothing to match against. */
      if (recordedHead === null) return null;
      if (!PROJECT_PATH.test(repo) || !repo.split('/').every(isPathSegment)) return null;
      if (branch.length === 0) return null;
      const lookup: Lookup = {
        token,
        origin: `https://${host}`,
        requestTimeoutMs: limits?.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
        deadline: AbortSignal.timeout(limits?.lookupTimeoutMs ?? DEFAULT_LOOKUP_TIMEOUT_MS),
        maxCandidatePullRequests:
          limits?.maxCandidatePullRequests ?? DEFAULT_MAX_CANDIDATE_PULL_REQUESTS,
        maxHeadComparisons: limits?.maxHeadComparisons ?? DEFAULT_MAX_HEAD_COMPARISONS,
        maxCandidatePages: limits?.maxCandidatePages ?? DEFAULT_MAX_CANDIDATE_PAGES,
      };
      const project = `${lookup.origin}/api/v4/projects/${encodeURIComponent(repo)}`;
      const getJson = (pathname: string, absent: readonly number[] = []) =>
        request(`${project}${pathname}`, lookup, {}, absent);

      const recorded =
        typeof recordedHead === 'string' && COMMIT_ID.test(recordedHead) ? recordedHead : undefined;
      let comparisons = 0;
      /**
       * With a recorded commit a merge request counts only when its head is that commit or builds
       * on it: their merge base is the recorded commit. Every comparison spends the configured
       * budget, and a commit GitLab does not know is no match.
       */
      const contains = async (sha: string): Promise<boolean> => {
        if (recorded == null || sha === recorded) return true;
        if (comparisons >= lookup.maxHeadComparisons) {
          logDiscoveryDiagnostic('gitlab', 'COMPARISON_LIMIT');
          return false;
        }
        comparisons += 1;
        const base = await getJson(
          `/repository/merge_base?refs[]=${recorded}&refs[]=${encodeURIComponent(sha)}`,
          [400],
        );
        if (base == null) {
          logDiscoveryDiagnostic('gitlab', 'COMPARISON_UNAVAILABLE');
          return false;
        }
        if (!isRecord(base) || typeof base.id !== 'string') {
          throw new PullRequestSourceError('UPSTREAM_ERROR');
        }
        return base.id === recorded;
      };
      /**
       * GitLab lists merge requests from forks under the same source branch name. A branch name
       * proves nothing for a fork (anyone can open `patch-1`), so a fork counts only when it
       * carries the recorded commit.
       */
      const matches = async (item: { sha: string; fromFork: boolean }): Promise<boolean> =>
        item.fromFork ? recorded != null && contains(item.sha) : contains(item.sha);

      const report = async (
        mergeRequest: GitLabMergeRequest,
      ): Promise<TConversationPullRequest> => {
        const stats = parseDiffStats(
          await request(`${lookup.origin}/api/graphql`, lookup, {
            method: 'POST',
            body: JSON.stringify({
              query: DIFF_STATS_QUERY,
              variables: { path: repo, iid: String(mergeRequest.iid) },
            }),
          }),
        );
        return {
          number: mergeRequest.iid,
          title: mergeRequest.title.slice(0, MAX_TITLE_LENGTH),
          url: mergeRequest.url,
          provider: 'gitlab',
          additions: stats.additions,
          deletions: stats.deletions,
          state: mergeRequest.state,
          isDraft: mergeRequest.draft,
          mergeable: mergeRequest.mergeable,
          checks: mergeRequest.checks,
        };
      };

      /** A merge request the conversation's own output linked to is read directly. */
      if (pullRequest != null && Number.isSafeInteger(pullRequest) && pullRequest > 0) {
        const linked = await getJson(`/merge_requests/${pullRequest}`);
        if (linked != null) {
          const mergeRequest = parseMergeRequest(linked, host);
          if (mergeRequest.sourceBranch === branch && (await matches(mergeRequest))) {
            return report(mergeRequest);
          }
        }
      }

      /** `undefined`: the project is not visible. An empty list: it is, and nothing matched. */
      const list = async (state: ListState, perPage: number, page: number) => {
        const query = new URLSearchParams({
          state,
          source_branch: branch,
          order_by: 'created_at',
          sort: 'desc',
          per_page: String(perPage),
          page: String(page),
        });
        const listed = await getJson(`/merge_requests?${query.toString()}`);
        if (listed == null) return undefined;
        if (!Array.isArray(listed)) throw new PullRequestSourceError('UPSTREAM_ERROR');
        return listed.map(parseListItem);
      };
      /**
       * Reads pages of one state up to the configured budget, a full page at a time even without
       * a recorded commit: a fork's merge request never matches without one, so the newest entry
       * is not necessarily the one that does.
       */
      const listAll = async (state: ListState): Promise<ListItem[] | undefined> => {
        const perPage = lookup.maxCandidatePullRequests;
        const pages = lookup.maxCandidatePages;
        const all: ListItem[] = [];
        for (let page = 1; page <= pages; page++) {
          const items = await list(state, perPage, page);
          if (items === undefined) return page === 1 ? undefined : all;
          all.push(...items);
          if (items.length < perPage) break;
        }
        return all;
      };
      const choose = async (candidates: ListItem[]): Promise<ListItem | null> => {
        for (const candidate of candidates) {
          if (await matches(candidate)) return candidate;
        }
        return null;
      };

      /** A project's `iid` grows with every merge request it creates, so it orders by age. */
      const newestFirst = (...lists: (ListItem[] | undefined)[]): ListItem[] =>
        lists.flatMap((items) => items ?? []).sort((a, b) => b.iid - a.iid);
      /** Open first on its own, so closed history on a reused branch name cannot hide it. GitLab
       *  lists a merge request that is being merged as `locked`, under no other state filter, and
       *  it is still the branch's live merge request, so it is read with the open ones. */
      const [opened, locked] = await Promise.all([listAll('opened'), listAll('locked')]);
      if (opened === undefined) return null;
      const open = newestFirst(opened, locked);
      /** Merged and closed are listed apart from open ones, so any number of open fork merge
       *  requests on the branch name cannot crowd the history out of its page budget. */
      const history = async (): Promise<ListItem[]> => {
        const [merged, closed] = await Promise.all([listAll('merged'), listAll('closed')]);
        return newestFirst(merged, closed);
      };
      const chosen = (await choose(open)) ?? (await choose(await history()));
      if (chosen == null) return null;

      const detail = await getJson(`/merge_requests/${chosen.iid}`);
      if (detail == null) return null;
      const mergeRequest = parseMergeRequest(detail, host);
      /** The merge request may have changed between the list and the detail: its source branch,
       *  the project it comes from, or a push that moved the head off the recorded commit. */
      if (mergeRequest.sourceBranch !== branch || mergeRequest.fromFork !== chosen.fromFork) {
        return null;
      }
      if (mergeRequest.sha !== chosen.sha && !(await matches(mergeRequest))) return null;
      return report(mergeRequest);
    },
  };
}
