import { logger, isValidObjectIdString } from '@librechat/data-schemas';
import {
  PermissionBits,
  ResourceType,
  DEFAULT_CACHE_CLEAR_TIMEOUT_MS,
} from 'librechat-data-provider';
import type { Response } from 'express';
import type { PromptGroupRecord, PromptServiceError, StoredId } from './types';
import type { PromptViaGroupResource } from './access';
import type { PromptService } from './service';
import type { ServerRequest } from '~/types';
import { contentFilterBlockResponse } from '~/middleware/contentFilter';
import { runBounded } from '~/agents/instructions/linked';
import { formatPromptGroupsResponse } from './format';
import { getSafeErrorMetadata } from '~/utils';
import { isPromptStoreError } from './errors';

/** A request after the prompt access middleware stored the resolved record. */
export type PromptRequest = ServerRequest & {
  resourceAccess?: { resourceInfo?: unknown };
};

type PromptHandler = (req: PromptRequest, res: Response) => Promise<Response | void>;

export interface PromptHandlersDeps {
  readonly service: PromptService;
  getPromptGroupAccessContext(params: { userId: string; role?: string }): Promise<{
    accessibleIds: readonly StoredId[];
    publiclyAccessibleIds: readonly StoredId[];
    ownedPromptGroupIds: readonly StoredId[];
  }>;
  getEffectivePermissions(params: {
    userId: string;
    role?: string;
    resourceType: ResourceType;
    resourceId: string;
  }): Promise<number>;
  /**
   * Clears the linked-instructions cache for a native prompt group after a write that
   * can change what a linked agent reads next: promote, delete a revision, delete a
   * group. Omitted where no cache is wired. A clear failure is logged and never fails
   * the write that triggered it.
   */
  invalidateLinkedPrompt?(groupId: string, promptIds: readonly string[]): Promise<void>;
}

export interface PromptHandlers {
  getPromptGroup: PromptHandler;
  listAllPromptGroups: PromptHandler;
  listPromptGroups: PromptHandler;
  createPromptGroup: PromptHandler;
  savePrompt: PromptHandler;
  recordPromptUsage: PromptHandler;
  updatePromptGroup: PromptHandler;
  makePromptProduction: PromptHandler;
  getPrompt: PromptHandler;
  getPrompts: PromptHandler;
  deletePrompt: PromptHandler;
  deletePromptGroup: PromptHandler;
}

function param(req: PromptRequest, name: string): string {
  return (req.params as Record<string, string>)[name];
}

function query(req: PromptRequest, name: string): string | undefined {
  const value = (req.query as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : undefined;
}

function body(req: PromptRequest): Record<string, unknown> {
  return (req.body ?? {}) as Record<string, unknown>;
}

function loadedGroup(req: PromptRequest): PromptGroupRecord | undefined {
  return req.resourceAccess?.resourceInfo as PromptGroupRecord | undefined;
}

function loadedRevision(req: PromptRequest) {
  return (req.resourceAccess?.resourceInfo as PromptViaGroupResource | undefined)?.prompt;
}

function sendRejection(res: Response, error: PromptServiceError): Response {
  if (error.type === 'blocked_content') {
    return res.status(400).json(contentFilterBlockResponse(error.finding));
  }
  if (error.type === 'invalid_input') {
    return res
      .status(400)
      .send(
        error.details === undefined
          ? { error: error.message }
          : { error: error.message, details: error.details },
      );
  }
  return res.status(400).send({ error: 'Prompt operation is not available' });
}

/**
 * Clears the linked-instructions cache so a promote or delete reaches linked agents
 * on the next request instead of after the cache's TTL. A no-op when no cache is
 * wired. The write this follows has already succeeded; the clear waits at most
 * `endpoints.agents.linkedInstructions.native.cacheClearTimeoutMs` (default
 * `DEFAULT_CACHE_CLEAR_TIMEOUT_MS`) and lets the delete finish in the background past
 * that limit. A timeout and a rejection both log and continue rather than surface,
 * since either one only loses cache warmth.
 */
async function clearLinkedPromptCache(
  deps: PromptHandlersDeps,
  req: PromptRequest,
  groupId: string,
  promptIds: readonly string[],
): Promise<void> {
  if (!deps.invalidateLinkedPrompt) {
    return;
  }
  const cacheClearTimeoutMs =
    req.config?.endpoints?.agents?.linkedInstructions?.native?.cacheClearTimeoutMs ??
    DEFAULT_CACHE_CLEAR_TIMEOUT_MS;
  try {
    await runBounded(deps.invalidateLinkedPrompt(groupId, promptIds), cacheClearTimeoutMs);
  } catch (error) {
    logger.error('[prompts] Failed to clear the linked-instructions cache', {
      groupId,
      ...getSafeErrorMetadata(error),
    });
  }
}

async function loadAccessContext(deps: PromptHandlersDeps, req: PromptRequest) {
  const context = await deps.getPromptGroupAccessContext({
    userId: req.user?.id ?? '',
    role: req.user?.role,
  });
  return {
    accessibleIds: context.accessibleIds.map(String),
    publiclyAccessibleIds: context.publiclyAccessibleIds.map(String),
    ownedPromptGroupIds: context.ownedPromptGroupIds.map(String),
  };
}

/**
 * HTTP handlers for the prompt routes. The router enforces authentication, role gates
 * and resource access before each handler. The handlers keep the existing status and
 * body for each failure, including the legacy 200 message bodies.
 */
export function createPromptHandlers(deps: PromptHandlersDeps): PromptHandlers {
  const { service } = deps;

  return {
    async getPromptGroup(req, res) {
      const groupId = param(req, 'groupId');
      try {
        const result = await service.getPromptGroup({
          groupId,
          loadedGroup: loadedGroup(req),
          filters: req.config?.filters,
        });
        if (result == null) {
          return res.status(404).send({ message: 'Prompt group not found' });
        }
        if (!result.ok) {
          return sendRejection(res, result.error);
        }
        return res.status(200).send(result.value);
      } catch (error) {
        logger.error('Error getting prompt group', error);
        if (isPromptStoreError(error, 'read')) {
          return res.status(404).send({ message: 'Prompt group not found' });
        }
        return res.status(500).send({ message: 'Error getting prompt group' });
      }
    },

    async listAllPromptGroups(req, res) {
      try {
        const result = await service.getListPromptGroupsByAccess({
          ...(await loadAccessContext(deps, req)),
          name: query(req, 'name'),
          category: query(req, 'category'),
          limit: null,
          after: null,
          forReuse: true,
          filters: req.config?.filters,
        });
        return res.status(200).send(result.data);
      } catch (error) {
        logger.error(error);
        return res.status(500).send({ error: 'Error getting prompt groups' });
      }
    },

    async listPromptGroups(req, res) {
      try {
        const pageSize = query(req, 'pageSize');
        const limit = query(req, 'limit');
        const actualLimit = pageSize && !limit ? parseInt(pageSize, 10) : limit;
        if (actualLimit == null) {
          logger.error('[GET /prompts/groups] limit or pageSize is required');
          return res.status(500).send({ error: 'Error getting prompt groups' });
        }
        let cursor = query(req, 'cursor') ?? null;
        if (cursor === 'undefined' || cursor === 'null' || cursor === '') {
          cursor = null;
        }

        const result = await service.getListPromptGroupsByAccess({
          ...(await loadAccessContext(deps, req)),
          name: query(req, 'name'),
          category: query(req, 'category'),
          limit: actualLimit,
          after: cursor,
          forReuse: false,
          filters: req.config?.filters,
        });
        return res.status(200).send(
          formatPromptGroupsResponse({
            promptGroups: [...result.data],
            pageNumber: '1',
            pageSize: actualLimit.toString(),
            hasMore: result.has_more,
            after: result.after,
          }),
        );
      } catch (error) {
        logger.error(error);
        return res.status(500).send({ error: 'Error getting prompt groups' });
      }
    },

    async createPromptGroup(req, res) {
      try {
        const { prompt, group } = body(req) as Pick<
          Parameters<PromptService['createPromptGroup']>[0],
          'prompt' | 'group'
        >;
        const result = await service.createPromptGroup({
          prompt,
          group,
          author: req.user?.id ?? '',
          authorName: req.user?.name,
          filters: req.config?.filters,
        });
        if (!result.ok) {
          return sendRejection(res, result.error);
        }
        return res.status(200).send(result.value);
      } catch (error) {
        logger.error(error);
        return res.status(500).send({ error: 'Error creating prompt group' });
      }
    },

    async savePrompt(req, res) {
      try {
        const result = await service.savePrompt({
          groupId: param(req, 'groupId'),
          prompt: body(req).prompt,
          author: req.user?.id ?? '',
          filters: req.config?.filters,
        });
        if (!result.ok) {
          return sendRejection(res, result.error);
        }
        return res.status(200).send(result.value);
      } catch (error) {
        logger.error(error);
        if (isPromptStoreError(error, 'write')) {
          return res.status(200).send({ message: 'Error saving prompt' });
        }
        return res.status(500).send({ error: 'Error adding prompt to group' });
      }
    },

    async recordPromptUsage(req, res) {
      try {
        const groupId = param(req, 'groupId');
        if (!isValidObjectIdString(groupId)) {
          return res.status(400).send({ error: 'Invalid groupId' });
        }
        return res.status(200).send(await service.incrementPromptGroupUsage(groupId));
      } catch (error) {
        logger.error('[recordPromptUsage]', error);
        const message = error instanceof Error ? error.message : undefined;
        if (message === 'Invalid groupId') {
          return res.status(400).send({ error: 'Invalid groupId' });
        }
        if (message === 'Prompt group not found') {
          return res.status(404).send({ error: 'Prompt group not found' });
        }
        return res.status(500).send({ error: 'Error recording prompt usage' });
      }
    },

    async updatePromptGroup(req, res) {
      try {
        const result = await service.updatePromptGroup({
          groupId: param(req, 'groupId'),
          updates: req.body,
          filters: req.config?.filters,
        });
        if (!result.ok) {
          return sendRejection(res, result.error);
        }
        return res.status(200).send(result.value);
      } catch (error) {
        logger.error(error);
        if (isPromptStoreError(error, 'write')) {
          return res.status(200).send({ message: 'Error updating prompt group' });
        }
        return res.status(500).send({ error: 'Error updating prompt group' });
      }
    },

    async makePromptProduction(req, res) {
      try {
        const result = await service.makePromptProduction({
          promptId: param(req, 'promptId'),
          loadedRevision: loadedRevision(req),
          filters: req.config?.filters,
        });
        if (!result.ok) {
          return sendRejection(res, result.error);
        }
        if (result.groupId) {
          await clearLinkedPromptCache(deps, req, result.groupId, []);
        }
        return res.status(200).send(result.value);
      } catch (error) {
        logger.error(error);
        if (isPromptStoreError(error, 'write')) {
          return res.status(200).send({ message: 'Error making prompt production' });
        }
        return res.status(500).send({ error: 'Error updating prompt production' });
      }
    },

    async getPrompt(req, res) {
      try {
        const result = await service.getPrompt({
          promptId: param(req, 'promptId'),
          loadedRevision: loadedRevision(req),
          filters: req.config?.filters,
        });
        if (result == null) {
          return res.status(200).send(null);
        }
        if (!result.ok) {
          return sendRejection(res, result.error);
        }
        return res.status(200).send(result.value);
      } catch (error) {
        logger.error('Error getting prompt', error);
        if (isPromptStoreError(error, 'read')) {
          return res.status(200).send({ message: 'Error getting prompt' });
        }
        return res.status(500).send({ message: 'Error getting prompt' });
      }
    },

    async getPrompts(req, res) {
      try {
        const groupId = query(req, 'groupId');
        if (!groupId) {
          return res.status(400).send({ error: 'Invalid or missing groupId' });
        }
        if (!isValidObjectIdString(groupId)) {
          return res.status(400).send({ error: 'Invalid groupId' });
        }
        const permissions = await deps.getEffectivePermissions({
          userId: req.user?.id ?? '',
          role: req.user?.role,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: groupId,
        });
        if (!(permissions & PermissionBits.VIEW)) {
          return res
            .status(403)
            .send({ error: 'Insufficient permissions to view prompts in this group' });
        }
        return res
          .status(200)
          .send(await service.getPrompts({ groupId, filters: req.config?.filters }));
      } catch (error) {
        logger.error(error);
        if (isPromptStoreError(error, 'read')) {
          return res.status(200).send({ message: 'Error getting prompts' });
        }
        return res.status(500).send({ error: 'Error getting prompts' });
      }
    },

    async deletePrompt(req, res) {
      try {
        const groupId = query(req, 'groupId');
        if (!groupId || !isValidObjectIdString(groupId)) {
          return res.status(400).send({ error: 'Invalid or missing groupId' });
        }
        const promptId = param(req, 'promptId');
        const result = await service.deletePrompt({ groupId, promptId });
        if (!result.ok) {
          return sendRejection(res, result.error);
        }
        await clearLinkedPromptCache(deps, req, groupId, [promptId]);
        return res.status(200).send(result.value);
      } catch (error) {
        logger.error(error);
        return res.status(500).send({ error: 'Error deleting prompt' });
      }
    },

    async deletePromptGroup(req, res) {
      try {
        const groupId = param(req, 'groupId');
        /* Revisions are gone once the group is deleted, so their IDs are read first —
         * only when a cache is wired, since otherwise nothing is cleared. A read failure
         * leaves exact-revision cache entries to expire by TTL; it is logged and the
         * delete proceeds. */
        let promptIds: readonly string[] = [];
        if (deps.invalidateLinkedPrompt) {
          try {
            promptIds = (await service.getPrompts({ groupId })).map((revision) => revision._id);
          } catch (error) {
            logger.error('[prompts] Failed to read revisions before deleting the group', {
              groupId,
              ...getSafeErrorMetadata(error),
            });
          }
        }
        const value = await service.deletePromptGroup(groupId);
        await clearLinkedPromptCache(deps, req, groupId, promptIds);
        return res.send(value);
      } catch (error) {
        logger.error('Error deleting prompt group', error);
        return res.status(500).send({ message: 'Error deleting prompt group' });
      }
    },
  };
}
