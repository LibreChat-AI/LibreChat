import { logger } from '@librechat/data-schemas';
import { AccessRoleIds, PrincipalType, ResourceType } from 'librechat-data-provider';
import type {
  FiltersConfig,
  TDeletePromptResponse,
  TMakePromptProductionResponse,
} from 'librechat-data-provider';
import type {
  PromptRecord,
  PromptDatabase,
  ResolvedPrompt,
  PromptListInput,
  PromptOperation,
  PromptGroupRecord,
  ResolvePromptInput,
  PromptServiceResult,
  PromptCreationResult,
  CreatePromptGroupInput,
  PromptServiceAdapters,
} from './types';
import type { ProjectedStoredPrompt, ProjectedStoredPromptGroup } from './protection';
import {
  inspectPromptContent,
  projectStoredPrompts,
  projectStoredPromptGroup,
  projectStoredPromptGroups,
} from './protection';
import {
  markPublicPromptGroups,
  buildPromptGroupFilter,
  filterAccessibleIdsBySharedLogic,
} from './format';
import {
  createPromptCatalogStore,
  createNativePromptAdapter,
  selectionUnavailableReason,
} from './native';
import { safeValidatePromptGroupUpdate, safeValidatePromptPayload } from './schemas';
import { withPromptStage } from './errors';

type WithPromptFilters<T> = T & { readonly filters?: FiltersConfig };
type ProjectedGroup = ProjectedStoredPromptGroup<PromptGroupRecord>;

export interface PromptServiceListResult {
  readonly data: readonly ProjectedGroup[];
  readonly has_more: boolean;
  readonly after: string | null;
}

/**
 * Prompt operations for authorized callers. The caller enforces access before each call.
 * Database failures throw `PromptStoreError` with the stage (`read` or `write`) where
 * they occurred, so the HTTP boundary can keep each route's existing response.
 */
export interface PromptService {
  resolvePrompt(input: ResolvePromptInput): Promise<PromptServiceResult<ResolvedPrompt>>;
  getListPromptGroupsByAccess(input: PromptListInput): Promise<PromptServiceListResult>;
  /** Returns the group's revisions, newest first. */
  getPrompts(
    input: WithPromptFilters<{ readonly groupId: string }>,
  ): Promise<readonly ProjectedStoredPrompt<PromptRecord>[]>;
  createPromptGroup(
    input: WithPromptFilters<CreatePromptGroupInput>,
  ): Promise<PromptServiceResult<PromptCreationResult>>;
  savePrompt(
    input: WithPromptFilters<{
      readonly groupId: string;
      readonly prompt: unknown;
      readonly author: string;
    }>,
  ): Promise<PromptServiceResult<{ readonly prompt: PromptRecord }>>;
  /**
   * Returns null when the group does not exist. A successful value of null means that
   * projection removed the group because its metadata is blocked.
   */
  getPromptGroup(
    input: WithPromptFilters<{
      readonly groupId: string;
      readonly loadedGroup?: PromptGroupRecord | null;
    }>,
  ): Promise<PromptServiceResult<ProjectedGroup | null> | null>;
  /** Returns null when the revision does not exist. */
  getPrompt(
    input: WithPromptFilters<{
      readonly promptId: string;
      readonly loadedRevision?: PromptRecord | null;
    }>,
  ): Promise<PromptServiceResult<PromptRecord> | null>;
  incrementPromptGroupUsage(groupId: string): Promise<{ readonly numberOfGenerations: number }>;
  updatePromptGroup(
    input: WithPromptFilters<{ readonly groupId: string; readonly updates: unknown }>,
  ): Promise<PromptServiceResult<PromptGroupRecord>>;
  makePromptProduction(
    input: WithPromptFilters<{
      readonly promptId: string;
      readonly loadedRevision?: PromptRecord | null;
    }>,
  ): Promise<PromptServiceResult<TMakePromptProductionResponse>>;
  deletePrompt(input: {
    readonly groupId: string;
    readonly promptId: string;
  }): Promise<PromptServiceResult<TDeletePromptResponse>>;
  deletePromptGroup(groupId: string): Promise<{ readonly message: string }>;
}

function invalidInput<T>(message: string, details?: unknown): PromptServiceResult<T> {
  return { ok: false, error: { type: 'invalid_input', message, details } };
}

function unsupported<T>(operation: PromptOperation): PromptServiceResult<T> {
  return { ok: false, error: { type: 'unsupported', operation } };
}

function inspect<T>(
  input: Parameters<typeof inspectPromptContent>[0],
  filters: FiltersConfig | undefined,
): PromptServiceResult<T> | null {
  const finding = inspectPromptContent(input, filters);
  return finding == null ? null : { ok: false, error: { type: 'blocked_content', finding } };
}

/** Builds the prompt service from a content source, a catalog store and an ownership grant. */
export function createPromptServiceFromAdapters(adapters: PromptServiceAdapters): PromptService {
  const { source, catalog, grantCreatorOwnership, logger } = adapters;

  const readPrompt = (promptId: string, loaded?: PromptRecord | null) =>
    loaded?._id === promptId
      ? Promise.resolve(loaded)
      : withPromptStage('read', () => source.getPrompt(promptId));

  return {
    async resolvePrompt({ filters, ...input }) {
      const resolved = await source.resolvePrompt(input);
      if (resolved == null) {
        return {
          ok: false,
          error: {
            type: 'unavailable_selection',
            reason: selectionUnavailableReason(input.selection),
          },
        };
      }
      return inspect({ prompt: resolved.prompt }, filters) ?? { ok: true, value: resolved };
    },

    async getListPromptGroupsByAccess(input) {
      const { name, category, searchShared, searchSharedOnly } = buildPromptGroupFilter(input);
      const accessibleIds = await filterAccessibleIdsBySharedLogic({
        accessibleIds: input.accessibleIds,
        searchShared,
        searchSharedOnly,
        publicPromptGroupIds: input.publiclyAccessibleIds,
        ownedPromptGroupIds: input.ownedPromptGroupIds,
      });
      const result = await catalog.getListPromptGroupsByAccess({
        accessibleIds,
        name,
        category,
        limit: input.limit,
        after: input.after,
      });
      const projected = projectStoredPromptGroups(result.data, input.filters, {
        forReuse: input.forReuse,
      });
      return {
        data: markPublicPromptGroups(projected, input.publiclyAccessibleIds),
        has_more: result.has_more,
        after: result.after,
      };
    },

    async getPrompts({ groupId, filters }) {
      const prompts = await withPromptStage('read', () => source.getPrompts(groupId));
      return projectStoredPrompts(prompts, filters);
    },

    async createPromptGroup({ filters, ...input }) {
      if (!input.prompt || !input.group || !input.group.name) {
        return invalidInput('Prompt and group name are required');
      }
      const validation = safeValidatePromptPayload(input.prompt);
      if (!validation.success) {
        return invalidInput(validation.error.issues[0]?.message ?? 'Invalid prompt');
      }
      const rejection = inspect<PromptCreationResult>(
        { prompt: validation.data, group: input.group },
        filters,
      );
      if (rejection != null) {
        return rejection;
      }
      const value = await source.createPromptGroup({ ...input, prompt: validation.data });
      const groupId = value.prompt?.groupId;
      if (value.prompt?._id && groupId) {
        try {
          await grantCreatorOwnership({ userId: input.author, groupId });
        } catch (error) {
          logger.error(
            `[createPromptGroup] Failed to grant owner permissions for promptGroup ${groupId}:`,
            error,
          );
        }
      }
      return { ok: true, value };
    },

    async savePrompt({ groupId, prompt, author, filters }) {
      if (!source.savePrompt) {
        return unsupported('savePrompt');
      }
      if (!prompt) {
        return invalidInput('Prompt is required');
      }
      const validation = safeValidatePromptPayload(prompt);
      if (!validation.success) {
        return invalidInput(validation.error.issues[0]?.message ?? 'Invalid prompt');
      }
      const rejection = inspect<{ prompt: PromptRecord }>({ prompt: validation.data }, filters);
      if (rejection != null) {
        return rejection;
      }
      const save = source.savePrompt;
      const value = await withPromptStage('write', () =>
        save({ groupId, prompt: validation.data, author }),
      );
      return { ok: true, value };
    },

    async getPromptGroup({ groupId, loadedGroup, filters }) {
      const group =
        loadedGroup?._id === groupId
          ? loadedGroup
          : await withPromptStage('read', () => source.getPromptGroup(groupId));
      if (group == null) {
        return null;
      }
      return (
        inspect<ProjectedGroup | null>({ group }, filters) ?? {
          ok: true,
          value: projectStoredPromptGroup(group, filters),
        }
      );
    },

    async getPrompt({ promptId, loadedRevision, filters }) {
      const revision = await readPrompt(promptId, loadedRevision);
      if (revision == null) {
        return null;
      }
      return inspect<PromptRecord>({ prompt: revision }, filters) ?? { ok: true, value: revision };
    },

    incrementPromptGroupUsage: (groupId) => catalog.incrementPromptGroupUsage(groupId),

    async updatePromptGroup({ groupId, updates, filters }) {
      const validation = safeValidatePromptGroupUpdate(updates);
      if (!validation.success) {
        return invalidInput('Invalid request body', validation.error.errors);
      }
      const rejection = inspect<PromptGroupRecord>({ group: validation.data }, filters);
      if (rejection != null) {
        return rejection;
      }
      const value = await withPromptStage('write', () =>
        catalog.updatePromptGroup(groupId, validation.data),
      );
      return { ok: true, value };
    },

    async makePromptProduction({ promptId, loadedRevision, filters }) {
      if (!source.makePromptProduction) {
        return unsupported('makePromptProduction');
      }
      const revision = await readPrompt(promptId, loadedRevision);
      const rejection = inspect<TMakePromptProductionResponse>(
        { prompt: revision ?? undefined },
        filters,
      );
      if (rejection != null) {
        return rejection;
      }
      const promote = source.makePromptProduction;
      const value = await withPromptStage('write', () => promote(promptId));
      return { ok: true, value };
    },

    async deletePrompt(input) {
      if (!source.deletePrompt) {
        return unsupported('deletePrompt');
      }
      return { ok: true, value: await source.deletePrompt(input) };
    },

    deletePromptGroup: (groupId) => catalog.deletePromptGroup(groupId),
  };
}

export interface PromptServiceDependencies {
  readonly db: PromptDatabase;
  readonly grantPermission: (input: {
    principalType: PrincipalType;
    principalId: string;
    resourceType: ResourceType;
    resourceId: string;
    accessRoleId: AccessRoleIds;
    grantedBy: string;
  }) => Promise<unknown>;
}

/** Builds the prompt service from the LibreChat database methods and permission service. */
export function createPromptService({
  db,
  grantPermission,
}: PromptServiceDependencies): PromptService {
  return createPromptServiceFromAdapters({
    source: createNativePromptAdapter(db),
    catalog: createPromptCatalogStore(db),
    grantCreatorOwnership: async ({ userId, groupId }) => {
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: userId,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: groupId,
        accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
        grantedBy: userId,
      });
      logger.debug(
        `[createPromptGroup] Granted owner permissions to user ${userId} for promptGroup ${groupId}`,
      );
    },
    logger,
  });
}
