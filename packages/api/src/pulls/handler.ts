import { logger } from '@librechat/data-schemas';
import { EModelEndpoint } from 'librechat-data-provider';
import type { TAgentsEndpoint, TConversationPullRequestResponse } from 'librechat-data-provider';
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

      if (laneGit?.branch == null || laneGit.repo == null) {
        res.status(200).json(NONE);
        return;
      }

      /** The repository comes from the worker, so it is never used with the token unless the
       *  administrator named it. A repository that is not allowed looks like one without a pull
       *  request. */
      if (!isAllowedRepository(laneGit.repo, settings.allowedRepositories)) {
        res.status(200).json(NONE);
        return;
      }

      const token = resolveTokenReference(settings.token, deps.env);
      if (token == null) {
        logger.warn('[PullRequests] Enabled without a usable token reference');
        res.status(503).json({ error: 'Pull requests are not configured', code: 'NOT_CONFIGURED' });
        return;
      }

      const result = await deps.lookup({
        repo: laneGit.repo,
        branch: laneGit.branch,
        head: laneGit.head,
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
      });
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
