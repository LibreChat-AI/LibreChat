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
import type { AppConfigUserLike, GetAppConfigOptions } from '~/app/service';
import type { PullRequestErrorCode, PullRequestLookup } from './types';
import type { PullRequestSettings } from './settings';
import type { ServerRequest } from '~/types';
import {
  resolvePullRequestHost,
  resolvePullRequestOAuth,
  resolvePullRequestToken,
  isPullRequestFeatureActive,
  resolvePullRequestProvider,
} from './settings';
import { ALL_REPOSITORIES, isAllowedRepository } from './repository';
import { getAppConfigOptionsFromUser } from '~/app/service';
import { getSafeErrorMetadata } from '~/utils';

const MAX_CONVERSATION_ID_LENGTH = 256;

export type ConversationLaneGit = {
  branch: string | null;
  head: string | null;
  repo?: string;
  pullRequest?: number;
};

const validConversationId = (value: string | undefined): value is string =>
  value != null && value.trim() !== '' && value.length <= MAX_CONVERSATION_ID_LENGTH;

const NONE: TConversationPullRequestResponse = { pullRequest: null };

type EligibleLane = { branch: string; head: string | null; repo: string; pullRequest?: number };

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

type LookupResultOf = Awaited<ReturnType<PullRequestLookup>>;
type SharedLookup = { promise: Promise<LookupResultOf | typeof TIMED_OUT>; interested: number };

/**
 * One upstream lookup per distinct input across every batch request of a handler. The first
 * request that needs a lane starts it and takes its slot; any other request for the same lane,
 * however concurrent, joins that promise and takes none. Interest is counted, so a lookup still
 * waiting for a slot starts only while some request still wants its answer, and one request
 * giving up never cancels what another is waiting for.
 */
function createSharedLookups(
  limiter: ReturnType<typeof createLookupLimiter>,
  lookup: PullRequestLookup,
) {
  const shared = new Map<string, SharedLookup>();
  return {
    /** `leave` must be called by a caller that stops waiting before the answer arrives. */
    join(
      key: string,
      scope: string,
      limit: number,
      input: Parameters<PullRequestLookup>[0],
    ): { promise: SharedLookup['promise']; leave: () => void } {
      let entry = shared.get(key);
      if (entry == null) {
        const created: SharedLookup = {
          interested: 0,
          promise: Promise.resolve(TIMED_OUT),
        };
        created.promise = (async () => {
          await limiter.acquire(scope, limit);
          try {
            if (created.interested === 0) {
              /** Nobody is waiting any more; a later request must start its own. */
              if (shared.get(key) === created) shared.delete(key);
              return TIMED_OUT;
            }
            return await lookup(input);
          } finally {
            limiter.release(scope, limit);
          }
        })().finally(() => {
          if (shared.get(key) === created) shared.delete(key);
        });
        shared.set(key, created);
        entry = created;
      }
      const joined = entry;
      joined.interested += 1;
      let left = false;
      return {
        promise: joined.promise,
        leave: () => {
          if (left) return;
          left = true;
          joined.interested -= 1;
        },
      };
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

/** The list a lane's repository is checked against, and a fork's checks are authorized by. */
const repositoryScope = (settings: PullRequestSettings): readonly string[] =>
  settings.allowAllRepositories === true ? ALL_REPOSITORIES : (settings.allowedRepositories ?? []);

/**
 * The token a lookup runs with and the repositories it may be used for. A user's own token sees
 * only what that user can see, so it is not held to the list the server's token is.
 */
/** `personal` marks the user's own token, the one a refusal invalidates. */
type Credential = { token: string; repositories: readonly string[]; personal?: true };

/** Clients know the codes a lookup has always had; a refused token is an upstream failure to them. */
const wireCode = (code: PullRequestErrorCode | string): string =>
  code === 'CREDENTIAL_REJECTED' ? 'UPSTREAM_ERROR' : code;

/** A refused personal token is invalidated, so the account reads as disconnected rather than
 *  failing every lookup; the server's token is the operator's to fix. */
async function invalidateRejected(
  userToken: PullRequestUserToken | undefined,
  userId: string,
  settings: PullRequestSettings,
  credential: Credential,
): Promise<void> {
  if (credential.personal !== true || userToken?.reject == null) return;
  try {
    await userToken.reject(userId, settings, credential.token);
  } catch (error) {
    logger.warn('[PullRequests] Refused user token not invalidated', getSafeErrorMetadata(error));
  }
}

function credentialOf(
  settings: PullRequestSettings,
  env: Readonly<Record<string, string | undefined>>,
  userToken: UserTokenRead,
): Credential | null {
  if (userToken === USER_TOKEN_FAILED) return null;
  if (userToken != null) {
    return { token: userToken, repositories: ALL_REPOSITORIES, personal: true };
  }
  const token = resolvePullRequestToken(
    settings.token,
    env,
    resolvePullRequestProvider(settings.provider) ?? undefined,
  );
  return token == null ? null : { token, repositories: repositoryScope(settings) };
}

/** Reads the user's own token, or null when the user has not connected an account. `reject`
 *  invalidates that token after the provider refused it on a lookup. */
export type PullRequestUserToken = ((
  userId: string,
  settings: PullRequestSettings,
) => Promise<string | null>) & {
  reject?: (userId: string, settings: PullRequestSettings, token: string) => Promise<void>;
};

/** A connected account whose token could not be read or refreshed (the provider or the key store
 *  is down). That is an outage, answered as one: neither "no pull request" nor the server's token,
 *  which may see less than the user's own. */
const USER_TOKEN_FAILED = Symbol('user token failed');
type UserTokenRead = string | null | typeof USER_TOKEN_FAILED;

/** Only with the feature on: reading the token can refresh, extend or delete the stored grant. */
async function readUserToken(
  userToken: PullRequestUserToken | undefined,
  userId: string,
  settings: PullRequestSettings | undefined,
  env: Readonly<Record<string, string | undefined>>,
): Promise<UserTokenRead> {
  if (userToken == null || settings == null || !isPullRequestFeatureActive(settings, env)) {
    return null;
  }
  try {
    return await userToken(userId, settings);
  } catch (error) {
    logger.warn('[PullRequests] User token unavailable', getSafeErrorMetadata(error));
    return USER_TOKEN_FAILED;
  }
}

/** A lane the credential may be used for: it names a branch and an allowed repository. */
function eligibleLane(
  laneGit: ConversationLaneGit | null | undefined,
  repositories: readonly string[],
): EligibleLane | null {
  if (laneGit?.branch == null || laneGit.repo == null) return null;
  if (!isAllowedRepository(laneGit.repo, repositories)) return null;
  return {
    branch: laneGit.branch,
    head: laneGit.head,
    repo: laneGit.repo,
    ...(laneGit.pullRequest != null ? { pullRequest: laneGit.pullRequest } : {}),
  };
}

/** Whether any credential could find a pull request for the lane, so reading the user's token
 *  (which can refresh and rotate it) is worth it. A lane with a branch and no commit yet (`head`
 *  null) has nothing to match against: every source answers no pull request for it. */
const isLookupable = (laneGit: ConversationLaneGit | null | undefined): boolean =>
  laneGit?.head !== null && eligibleLane(laneGit, ALL_REPOSITORIES) != null;

const agentsPullRequests = (config: AppConfig): PullRequestSettings | undefined =>
  (config.endpoints?.[EModelEndpoint.agents] as TAgentsEndpoint | undefined)?.pullRequests;

/**
 * The user's settings, with `provider`, `host` and `oauth` taken from the operator's YAML alone.
 * Role, group and user overrides live in the database and may be edited by delegated
 * administrators; letting one choose any of them would let it send a token to a server of its
 * choosing.
 */
export async function readPullRequestSettings(
  getAppConfig: (options: GetAppConfigOptions) => Promise<AppConfig>,
  user: AppConfigUserLike | null | undefined,
): Promise<PullRequestSettings | undefined> {
  const options = { ...getAppConfigOptionsFromUser(user), skipRuntimeAugmentation: true };
  const [resolved, base] = await Promise.all([
    getAppConfig({ ...options, failClosed: true }),
    getAppConfig({ ...options, baseOnly: true }),
  ]);
  const settings = agentsPullRequests(resolved);
  if (settings == null) return undefined;
  const { host: _host, provider: _provider, oauth: _oauth, ...rest } = settings;
  const operator = agentsPullRequests(base);
  return {
    ...rest,
    ...(operator?.provider != null ? { provider: operator.provider } : {}),
    ...(operator?.host != null ? { host: operator.host } : {}),
    ...(operator?.oauth != null ? { oauth: operator.oauth } : {}),
  };
}

/** Everything one lookup needs from the settings, so the single and batch routes cannot differ. */
function lookupInput(settings: PullRequestSettings, credential: Credential, lane: EligibleLane) {
  return {
    repo: lane.repo,
    branch: lane.branch,
    head: lane.head,
    ...(lane.pullRequest != null ? { pullRequest: lane.pullRequest } : {}),
    provider: resolvePullRequestProvider(settings.provider) ?? undefined,
    host:
      resolvePullRequestHost(
        settings.host,
        resolvePullRequestProvider(settings.provider) ?? undefined,
      ) ?? undefined,
    token: credential.token,
    ttlMs: (settings.cacheTtlSeconds ?? 30) * 1000,
    cacheMaxEntries: settings.cacheMaxEntries ?? 500,
    cacheMaxCredentials: settings.cacheMaxCredentials ?? 256,
    sharedCache: settings.sharedCache === true,
    sharedCacheTimeoutMs: settings.sharedCacheTimeoutMs ?? 250,
    sharedCacheSlots: settings.sharedCacheSlots ?? 65_536,
    allowedRepositories: credential.repositories,
    limits: {
      requestTimeoutMs: (settings.requestTimeoutSeconds ?? 10) * 1000,
      lookupTimeoutMs: (settings.lookupTimeoutSeconds ?? 30) * 1000,
      maxCheckRunPages: settings.maxCheckRunPages ?? 10,
      maxCandidatePullRequests: settings.maxCandidatePullRequests ?? 10,
      maxHeadComparisons: settings.maxHeadComparisons ?? 3,
      maxCandidatePages: settings.maxCandidatePages ?? 1,
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
  /** The user's own token, when users can connect their accounts. */
  userToken?: PullRequestUserToken;
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
      const [settings, laneGit] = await Promise.all([
        readPullRequestSettings(deps.getAppConfig, req.user),
        deps.getConvoLaneGit(userId, conversationId),
      ]);
      if (!settings || !isPullRequestFeatureActive(settings, deps.env)) {
        res.status(200).json(NONE);
        return;
      }
      /** Reading the user's token can refresh and rotate it, so only a lane that some credential
       *  could look up is worth it; any other conversation has no pull request regardless. */
      const userToken = !isLookupable(laneGit)
        ? null
        : await readUserToken(deps.userToken, userId, settings, deps.env);

      const credential = credentialOf(settings, deps.env, userToken);
      if (userToken === USER_TOKEN_FAILED) {
        res
          .status(503)
          .json({ error: 'Pull request lookup is unavailable', code: 'UPSTREAM_ERROR' });
        return;
      }
      /** Users can connect their own account and this one has not: nothing to look up with. */
      if (credential == null && resolvePullRequestOAuth(settings, deps.env) != null) {
        res.status(200).json(NONE);
        return;
      }
      if (credential == null) {
        logger.warn('[PullRequests] Enabled without a usable token reference');
        res.status(503).json({ error: 'Pull requests are not configured', code: 'NOT_CONFIGURED' });
        return;
      }

      /** The repository comes from the worker, so it is never used with the server's token unless
       *  the administrator named it. A repository that is not allowed looks like one without a
       *  pull request. */
      const lane = eligibleLane(laneGit, credential.repositories);
      if (lane == null) {
        res.status(200).json(NONE);
        return;
      }

      const result = await deps.lookup(lookupInput(settings, credential, lane));
      if (!result.ok) {
        if (result.error.code === 'CREDENTIAL_REJECTED') {
          /** In the background: the answer does not wait on it, and it fails only to a log. */
          void invalidateRejected(deps.userToken, userId, settings, credential);
        }
        res.status(503).json({
          error: 'Pull request lookup is unavailable',
          code: wireCode(result.error.code),
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
  /** The user's own token, when users can connect their accounts. */
  userToken?: PullRequestUserToken;
}) {
  const limiter = createLookupLimiter();
  const sharedLookups = createSharedLookups(limiter, deps.lookup);
  return async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const ids = parseConversationIds(req.body);
    if (!userId || ids == null) {
      res.status(400).json({ error: 'Invalid conversation list' });
      return;
    }
    /** Set once the request is answered, however it ended. */
    let answered = false;
    try {
      /**
       * The clock starts when the request arrives. The configured deadline lives in the config,
       * so until the config has loaded the default applies to it; once it has, the lane read and
       * everything after it share what is left of the configured deadline, however the two reads
       * overlapped.
       */
      const startedAt = Date.now();
      const configRead = readPullRequestSettings(deps.getAppConfig, req.user);
      const laneRead = deps.getConvosLaneGit(userId, ids);
      /** Once the settings and the lanes are in, and only if some lane could be looked up: reading
       *  the user's token can refresh and rotate it. */
      const userTokenRead = Promise.all([configRead, laneRead]).then(([loaded, lanes]) => {
        /** Never started for a request already answered or out of time: nobody would wait for
         *  it, and it could still refresh, extend or refuse the stored grant. */
        const deadline =
          startedAt + (loaded?.batchTimeoutSeconds ?? DEFAULT_BATCH_TIMEOUT_SECONDS) * 1000;
        if (answered || Date.now() >= deadline) return null;
        return lanes.some(({ laneGit }) => isLookupable(laneGit))
          ? readUserToken(deps.userToken, userId, loaded, deps.env)
          : null;
      });
      /** A read nobody waits for (feature off, config timed out) must not fail unhandled. */
      laneRead.catch(() => undefined);
      userTokenRead.catch(() => undefined);
      const unavailable = () =>
        res
          .status(503)
          .json({ error: 'Pull request lookup is unavailable', code: 'UPSTREAM_ERROR' });
      const loaded = await withDeadline(configRead, DEFAULT_BATCH_TIMEOUT_SECONDS * 1000);
      if (loaded === TIMED_OUT) {
        unavailable();
        return;
      }
      const settings = loaded;
      const deadline =
        startedAt + (settings?.batchTimeoutSeconds ?? DEFAULT_BATCH_TIMEOUT_SECONDS) * 1000;
      const none = (): TConversationPullRequestsResponse => ({
        results: ids.map((conversationId) => ({ conversationId, pullRequest: null })),
      });
      if (!settings || !isPullRequestFeatureActive(settings, deps.env)) {
        res.status(200).json(none());
        return;
      }

      const reads = await withDeadline(
        Promise.all([laneRead, userTokenRead]),
        deadline - Date.now(),
      );
      if (reads === TIMED_OUT) {
        unavailable();
        return;
      }
      const [lanes, userToken] = reads;
      const credential = credentialOf(settings, deps.env, userToken);
      const userTokenFailed = userToken === USER_TOKEN_FAILED;
      /** Users can connect their own account and this one has not: nothing to look up with. */
      if (
        credential == null &&
        !userTokenFailed &&
        resolvePullRequestOAuth(settings, deps.env) != null
      ) {
        res.status(200).json(none());
        return;
      }

      /** The repositories the missing credential would have been used for: every one, for a
       *  user's own token that failed to load. */
      const repositories =
        credential?.repositories ??
        (userTokenFailed ? ALL_REPOSITORIES : repositoryScope(settings));
      const eligible = new Map<string, EligibleLane>();
      for (const { conversationId, laneGit } of lanes) {
        const lane = eligibleLane(laneGit, repositories);
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
      if (credential == null) {
        if (!userTokenFailed)
          logger.warn('[PullRequests] Enabled without a usable token reference');
        const code = userTokenFailed ? 'UPSTREAM_ERROR' : 'NOT_CONFIGURED';
        res.status(200).json({
          results: ids.map(
            (conversationId): TConversationPullRequestsEntry =>
              eligible.has(conversationId)
                ? { conversationId, error: { code } }
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
      const scope = limiterScope(credential.token);
      /**
       * Conversations that share a repository, branch and head share one answer, and the lookup
       * already coalesces them, so each distinct lookup takes one slot and one deadline, not one
       * per conversation. Otherwise duplicates would hold every slot while a single request ran.
       */
      const keyOf = (lane: EligibleLane) =>
        `${lane.repo}\0${lane.branch}\0${lane.head ?? ''}\0${lane.pullRequest ?? ''}`;
      const distinct = new Map<string, EligibleLane>();
      for (const lane of eligible.values()) distinct.set(keyOf(lane), lane);
      type Outcome =
        | { ok: true; value: TConversationPullRequest | null }
        | { ok: false; code: string };
      const outcomes = new Map<string, Outcome>();
      await mapWithLimit([...distinct.entries()], limit, async ([key, lane]): Promise<void> => {
        /** Checked before anything is joined, so nothing starts once time is up. */
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          outcomes.set(key, { ok: false, code: 'UPSTREAM_ERROR' });
          return;
        }
        const input = lookupInput(settings, credential, lane);
        /** The same lane under the same policy is one lookup for every request that wants it. */
        const shareKey = `${scope}\0${JSON.stringify([
          input.provider,
          input.host,
          input.repo,
          input.branch,
          input.head,
          input.pullRequest,
          input.ttlMs,
          input.limits,
          input.allowedRepositories,
          /** Where the lookup caches and shares its answer, so each caller's own policy holds. */
          input.cacheMaxEntries,
          input.cacheMaxCredentials,
          input.sharedCache,
          input.sharedCacheTimeoutMs,
        ])}`;
        const joined = sharedLookups.join(shareKey, scope, limit, input);
        const result = await withDeadline(joined.promise, remaining);
        if (result === TIMED_OUT) {
          joined.leave();
          outcomes.set(key, { ok: false, code: 'UPSTREAM_ERROR' });
          return;
        }
        outcomes.set(
          key,
          result.ok ? { ok: true, value: result.value } : { ok: false, code: result.error.code },
        );
      });
      if ([...outcomes.values()].some((o) => !o.ok && o.code === 'CREDENTIAL_REJECTED')) {
        /** In the background: the answer does not wait on it, and it fails only to a log. */
        void invalidateRejected(deps.userToken, userId, settings, credential);
      }
      const looked = ids.map((conversationId): TConversationPullRequestsEntry => {
        const lane = eligible.get(conversationId);
        const outcome = lane == null ? undefined : outcomes.get(keyOf(lane));
        if (outcome == null) return { conversationId, pullRequest: null };
        return outcome.ok
          ? { conversationId, pullRequest: outcome.value }
          : { conversationId, error: { code: wireCode(outcome.code) } };
      });
      res.status(200).json({ results: looked });
    } catch (error) {
      logger.error('[PullRequests] Batch handler failed', getSafeErrorMetadata(error));
      res.status(500).json({ error: 'Failed to load the pull requests' });
    } finally {
      answered = true;
    }
  };
}
