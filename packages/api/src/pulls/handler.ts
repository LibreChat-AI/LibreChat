import { logger } from '@librechat/data-schemas';
import { EModelEndpoint, PULL_REQUEST_BATCH_MAX } from 'librechat-data-provider';
import type {
  TAgentsEndpoint,
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
  return async (req: ServerRequest, res: Response): Promise<void> => {
    const userId = req.user?.id;
    const ids = parseConversationIds(req.body);
    if (!userId || ids == null) {
      res.status(400).json({ error: 'Invalid conversation list' });
      return;
    }
    try {
      const [appConfig, lanes] = await Promise.all([
        deps.getAppConfig({
          ...getAppConfigOptionsFromUser(req.user),
          skipRuntimeAugmentation: true,
          failClosed: true,
        }),
        deps.getConvosLaneGit(userId, ids),
      ]);
      const settings = (appConfig.endpoints?.[EModelEndpoint.agents] as TAgentsEndpoint | undefined)
        ?.pullRequests;
      const none = (): TConversationPullRequestsResponse => ({
        results: ids.map((conversationId) => ({ conversationId, pullRequest: null })),
      });
      if (settings?.enabled !== true) {
        res.status(200).json(none());
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

      const token = resolveTokenReference(settings.token, deps.env);
      if (token == null) {
        logger.warn('[PullRequests] Enabled without a usable token reference');
        res.status(503).json({ error: 'Pull requests are not configured', code: 'NOT_CONFIGURED' });
        return;
      }

      const looked = await mapWithLimit(
        ids,
        settings.maxConcurrentLookups ?? DEFAULT_BATCH_CONCURRENCY,
        async (conversationId): Promise<TConversationPullRequestsEntry> => {
          const lane = eligible.get(conversationId);
          if (lane == null) return { conversationId, pullRequest: null };
          const result = await deps.lookup(lookupInput(settings, token, lane));
          return result.ok
            ? { conversationId, pullRequest: result.value }
            : { conversationId, error: { code: result.error.code } };
        },
      );
      res.status(200).json({ results: looked });
    } catch (error) {
      logger.error('[PullRequests] Batch handler failed', getSafeErrorMetadata(error));
      res.status(500).json({ error: 'Failed to load the pull requests' });
    }
  };
}
