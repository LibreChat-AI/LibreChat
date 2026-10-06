import { createHash } from 'node:crypto';
import { logger } from '@librechat/data-schemas';
import { EModelEndpoint, PULL_REQUEST_BATCH_MAX } from 'librechat-data-provider';
import type {
  TAgentsEndpoint,
  TConversationPullRequest,
  TConversationPullRequestsEntry,
  TConversationPullRequestResponse,
  TConversationPullRequestsResponse,
} from 'librechat-data-provider';
import type { AppConfig } from '@librechat/data-schemas';
import type { Response } from 'express';
import type { GetAppConfigOptions } from '~/app/service';
import type { PullRequestLookup } from './types';
import type { ServerRequest } from '~/types';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { getSafeErrorMetadata } from '~/utils';

const MAX_CONVERSATION_ID_LENGTH = 256;
const TOKEN_REFERENCE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

export type ConversationLaneGit = { branch: string | null; head: string | null; repo?: string };

/** Resolves `${NAME}` against the environment; the config never holds the token itself. */
export function resolveTokenReference(
  reference: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  const name = reference == null ? undefined : TOKEN_REFERENCE.exec(reference)?.[1];
  if (name == null) return null;
  return env[name]?.trim() || null;
}

/** `owner/name` or `owner/*`, compared without case as GitHub does. Nothing else matches. */
export function isAllowedRepository(repo: string, allowed: readonly string[] | undefined): boolean {
  const [owner, name] = repo.toLowerCase().split('/');
  return (allowed ?? []).some((entry) => {
    const [allowedOwner, allowedName] = entry.toLowerCase().split('/');
    return allowedOwner === owner && (allowedName === '*' || allowedName === name);
  });
}

const validConversationId = (value: string | undefined): value is string =>
  value != null && value.trim() !== '' && value.length <= MAX_CONVERSATION_ID_LENGTH;

const NONE: TConversationPullRequestResponse = { pullRequest: null };

type PullRequestSettings = NonNullable<TAgentsEndpoint['pullRequests']>;
type EligibleLane = { branch: string; head: string | null; repo: string };

/** Lookups in flight at once for one batch, unless configured. */
const DEFAULT_BATCH_CONCURRENCY = 4;
/** Longest one batch request may stay open, unless configured. */
const DEFAULT_BATCH_TIMEOUT_SECONDS = 20;

const TIMED_OUT = Symbol('timed-out');

/**
 * Lookups in flight across every batch request of one handler. A lookup that outlives its
 * request's deadline keeps running (and keeps its slot) until it really ends, so the next request
 * cannot start another on top of it: the configured concurrency holds across requests, not only
 * within one. Waiters are served in order.
 */
function createLookupLimiter() {
  type Scope = { active: number; waiting: Array<() => void> };
  const scopes = new Map<string, Scope>();
  return {
    /** Resolves once a slot is free under `limit`; the caller must `release` exactly once. */
    acquire(scopeKey: string, limit: number): Promise<void> {
      const scope = scopes.get(scopeKey) ?? { active: 0, waiting: [] };
      scopes.set(scopeKey, scope);
      if (scope.active < limit) {
        scope.active += 1;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        scope.waiting.push(() => {
          scope.active += 1;
          resolve();
        });
      });
    },
    release(scopeKey: string, limit: number): void {
      const scope = scopes.get(scopeKey);
      if (scope == null) return;
      scope.active -= 1;
      while (scope.waiting.length > 0 && scope.active < limit) scope.waiting.shift()?.();
      /** An idle scope holds nothing, so credentials that come and go leave no entries behind. */
      if (scope.active === 0 && scope.waiting.length === 0) scopes.delete(scopeKey);
    },
  };
}

/** A credential's digest, never the token, names the scope a lookup's slot is counted in. */
const limiterScope = (token: string): string =>
  createHash('sha256').update(token).digest('hex').slice(0, 32);

/** Settles with `TIMED_OUT` once `ms` has passed, and never leaves its timer running. */
async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  if (ms <= 0) return TIMED_OUT;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms);
  });
  try {
    return await Promise.race([work, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** A lane the server's token may be used for: it names a branch and an allowed repository. */
function eligibleLane(
  laneGit: ConversationLaneGit | null | undefined,
  settings: PullRequestSettings,
): EligibleLane | null {
  if (laneGit?.branch == null || laneGit.repo == null) return null;
  if (!isAllowedRepository(laneGit.repo, settings.allowedRepositories)) return null;
  return { branch: laneGit.branch, head: laneGit.head, repo: laneGit.repo };
}

/** Everything one lookup needs from the settings, so the single and batch routes cannot differ. */
function lookupInput(settings: PullRequestSettings, token: string, lane: EligibleLane) {
  return {
    repo: lane.repo,
    branch: lane.branch,
    head: lane.head,
    token,
    ttlMs: (settings.cacheTtlSeconds ?? 30) * 1000,
    cacheMaxEntries: settings.cacheMaxEntries ?? 500,
    cacheMaxCredentials: settings.cacheMaxCredentials ?? 256,
    limits: {
      requestTimeoutMs: (settings.requestTimeoutSeconds ?? 10) * 1000,
      lookupTimeoutMs: (settings.lookupTimeoutSeconds ?? 30) * 1000,
      maxCheckRunPages: settings.maxCheckRunPages ?? 10,
      maxCandidatePullRequests: settings.maxCandidatePullRequests ?? 10,
      maxHeadComparisons: settings.maxHeadComparisons ?? 3,
    },
  };
}

/** Runs `task` over `items` with at most `limit` in flight, keeping the results in order. */
async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < items.length; index = next++) {
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/** Accepts only a non-empty list of valid ids within the batch bound; duplicates collapse. */
function parseConversationIds(body: unknown): string[] | null {
  const ids = (body as { conversationIds?: unknown } | null | undefined)?.conversationIds;
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > PULL_REQUEST_BATCH_MAX) return null;
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== 'string' || !validConversationId(id)) return null;
    seen.add(id);
  }
  return [...seen];
}

/**
 * Serves the pull request of the branch a conversation's code workspace last reported. The
 * stored branch is read owner-scoped, so another user's conversation is indistinguishable from
 * one without a pull request. Failures answer with a stable code and never with upstream text.
 */
export function createConversationPullRequestHandler(deps: {
  getConvoLaneGit: (user: string, conversationId: string) => Promise<ConversationLaneGit | null>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  lookup: PullRequestLookup;
  env: Readonly<Record<string, string | undefined>>;
}) {
  return async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const { conversationId } = req.params as { conversationId?: string };
    if (!userId || !validConversationId(conversationId)) {
      res.status(404).json({ error: 'Conversation not found' });
      return;
    }
    try {
      /**
       * Config and the owner-scoped lane are independent, so they load together. The lane is only
       * used when the resolved config turns the feature on, which keeps a disabled deployment's
       * answer the same as before.
       */
      const [appConfig, laneGit] = await Promise.all([
        deps.getAppConfig({
          ...getAppConfigOptionsFromUser(req.user),
          skipRuntimeAugmentation: true,
          failClosed: true,
        }),
        deps.getConvoLaneGit(userId, conversationId),
      ]);
      const settings = (appConfig.endpoints?.[EModelEndpoint.agents] as TAgentsEndpoint | undefined)
        ?.pullRequests;
      if (settings?.enabled !== true) {
        res.status(200).json(NONE);
        return;
      }

      /** The repository comes from the worker, so it is never used with the token unless the
       *  administrator named it. A repository that is not allowed looks like one without a pull
       *  request. */
      const lane = eligibleLane(laneGit, settings);
      if (lane == null) {
        res.status(200).json(NONE);
        return;
      }

      const token = resolveTokenReference(settings.token, deps.env);
      if (token == null) {
        logger.warn('[PullRequests] Enabled without a usable token reference');
        res.status(503).json({ error: 'Pull requests are not configured', code: 'NOT_CONFIGURED' });
        return;
      }

      const result = await deps.lookup(lookupInput(settings, token, lane));
      if (!result.ok) {
        res.status(503).json({
          error: 'Pull request lookup is unavailable',
          code: result.error.code,
        });
        return;
      }
      res.status(200).json({ pullRequest: result.value });
    } catch (error) {
      logger.error('[PullRequests] Handler failed', getSafeErrorMetadata(error));
      res.status(500).json({ error: 'Failed to load the pull request' });
    }
  };
}

/**
 * Serves the pull requests of many conversations at once, for the sidebar list. It answers what
 * the single route answers for each id, from one owner-scoped read of the stored lanes, so a
 * conversation that is missing, expired, another user's or without a lane is simply "no pull
 * request". Each entry carries its own result or a stable failure code, so one repository's
 * rate limit does not hide the others. Lookups share the single route's cache, in-flight
 * sharing and rate-limit cooldown, and run a few at a time.
 */
export function createConversationPullRequestsHandler(deps: {
  getConvosLaneGit: (
    user: string,
    conversationIds: string[],
  ) => Promise<Array<{ conversationId: string; laneGit: ConversationLaneGit }>>;
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>;
  lookup: PullRequestLookup;
  env: Readonly<Record<string, string | undefined>>;
}) {
  const limiter = createLookupLimiter();
  return async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const ids = parseConversationIds(req.body);
    if (!userId || ids == null) {
      res.status(400).json({ error: 'Invalid conversation list' });
      return;
    }
    try {
      /**
       * The clock starts when the request arrives. The configured deadline lives in the config,
       * so until the config has loaded the default applies to it; once it has, the lane read and
       * everything after it share what is left of the configured deadline, however the two reads
       * overlapped.
       */
      const startedAt = Date.now();
      const configRead = deps.getAppConfig({
        ...getAppConfigOptionsFromUser(req.user),
        skipRuntimeAugmentation: true,
        failClosed: true,
      });
      const laneRead = deps.getConvosLaneGit(userId, ids);
      /** A lane read nobody waits for (feature off, config timed out) must not fail unhandled. */
      laneRead.catch(() => undefined);
      const unavailable = () =>
        res
          .status(503)
          .json({ error: 'Pull request lookup is unavailable', code: 'UPSTREAM_ERROR' });
      const loaded = await withDeadline(configRead, DEFAULT_BATCH_TIMEOUT_SECONDS * 1000);
      if (loaded === TIMED_OUT) {
        unavailable();
        return;
      }
      const appConfig = loaded;
      const settings = (appConfig.endpoints?.[EModelEndpoint.agents] as TAgentsEndpoint | undefined)
        ?.pullRequests;
      const deadline =
        startedAt + (settings?.batchTimeoutSeconds ?? DEFAULT_BATCH_TIMEOUT_SECONDS) * 1000;
      const none = (): TConversationPullRequestsResponse => ({
        results: ids.map((conversationId) => ({ conversationId, pullRequest: null })),
      });
      if (settings?.enabled !== true) {
        res.status(200).json(none());
        return;
      }

      const lanes = await withDeadline(laneRead, deadline - Date.now());
      if (lanes === TIMED_OUT) {
        unavailable();
        return;
      }

      const eligible = new Map<string, EligibleLane>();
      for (const { conversationId, laneGit } of lanes) {
        const lane = eligibleLane(laneGit, settings);
        if (lane != null) eligible.set(conversationId, lane);
      }
      if (eligible.size === 0) {
        res.status(200).json(none());
        return;
      }

      /**
       * A missing token is a fact about the conversations that needed one, not about the request:
       * those entries say so, and every other conversation keeps its correct "no pull request".
       */
      const token = resolveTokenReference(settings.token, deps.env);
      if (token == null) {
        logger.warn('[PullRequests] Enabled without a usable token reference');
        res.status(200).json({
          results: ids.map(
            (conversationId): TConversationPullRequestsEntry =>
              eligible.has(conversationId)
                ? { conversationId, error: { code: 'NOT_CONFIGURED' } }
                : { conversationId, pullRequest: null },
          ),
        });
        return;
      }

      /**
       * One deadline for the whole request, not per lookup: each lookup may run for its own
       * configured limit, and a stalled upstream would otherwise hold a full batch open for many
       * times that. Past the deadline nothing new starts and the entries still waiting answer
       * with an upstream error; a lookup already running finishes in the background under its own
       * limit and fills the cache for the next request.
       */
      const limit = settings.maxConcurrentLookups ?? DEFAULT_BATCH_CONCURRENCY;
      const scope = limiterScope(token);
      /**
       * Conversations that share a repository, branch and head share one answer, and the lookup
       * already coalesces them, so each distinct lookup takes one slot and one deadline, not one
       * per conversation. Otherwise duplicates would hold every slot while a single request ran.
       */
      const keyOf = (lane: EligibleLane) => `${lane.repo}\0${lane.branch}\0${lane.head ?? ''}`;
      const distinct = new Map<string, EligibleLane>();
      for (const lane of eligible.values()) distinct.set(keyOf(lane), lane);
      type Outcome =
        | { ok: true; value: TConversationPullRequest | null }
        | { ok: false; code: string };
      const outcomes = new Map<string, Outcome>();
      await mapWithLimit([...distinct.entries()], limit, async ([key, lane]): Promise<void> => {
        /** Checked before a slot is taken, so nothing starts once time is up. */
        const remaining = deadline - Date.now();
        let abandoned = false;
        /** Holds its slot until the lookup itself ends, whether or not anyone is still waiting. */
        const run = async () => {
          await limiter.acquire(scope, limit);
          try {
            if (abandoned) return TIMED_OUT;
            return await deps.lookup(lookupInput(settings, token, lane));
          } finally {
            limiter.release(scope, limit);
          }
        };
        const result = remaining <= 0 ? TIMED_OUT : await withDeadline(run(), remaining);
        if (result === TIMED_OUT) {
          abandoned = true;
          outcomes.set(key, { ok: false, code: 'UPSTREAM_ERROR' });
          return;
        }
        outcomes.set(
          key,
          result.ok ? { ok: true, value: result.value } : { ok: false, code: result.error.code },
        );
      });
      const looked = ids.map((conversationId): TConversationPullRequestsEntry => {
        const lane = eligible.get(conversationId);
        const outcome = lane == null ? undefined : outcomes.get(keyOf(lane));
        if (outcome == null) return { conversationId, pullRequest: null };
        return outcome.ok
          ? { conversationId, pullRequest: outcome.value }
          : { conversationId, error: { code: outcome.code } };
      });
      res.status(200).json({ results: looked });
    } catch (error) {
      logger.error('[PullRequests] Batch handler failed', getSafeErrorMetadata(error));
      res.status(500).json({ error: 'Failed to load the pull requests' });
    }
  };
}
