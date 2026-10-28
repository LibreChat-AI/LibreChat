import { logger, BASE_CONFIG_PRINCIPAL_ID } from '@librechat/data-schemas';
import { AccessRoleIds, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { FiltersConfig, TDeletePromptResponse } from 'librechat-data-provider';
import type {
  PromptRecord,
  PromptDatabase,
  ResolvedPrompt,
  PromptListInput,
  PromptOperation,
  PromptGroupRecord,
  ResolvePromptInput,
  PromptServiceError,
  PromptServiceResult,
  ImportSourceGroupInput,
  PromptCreationResult,
  CreatePromptGroupInput,
  PromptServiceAdapters,
  MakePromptProductionResult,
  PromptSourceImportOutcome,
} from './types';
import type { ProjectedStoredPrompt, ProjectedStoredPromptGroup } from './protection';
import type { CreateLangfuseSourceResolverDeps } from '../langfuse/promptSync';
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
import { safeValidatePromptGroupUpdate, safeValidatePromptPayload } from './schemas';
import { createNativePromptAdapter, selectionUnavailableReason } from './native';
import { createLangfuseSourceResolver } from '../langfuse/promptSync';
import { createLangfusePromptAdapter } from './langfuse';
import { getSafeErrorMetadata } from '~/utils';
import { createPromptStore } from './store';
import { withPromptStage } from './errors';
import { CONSTANTS } from '~/mcp/enum';

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
      readonly loadedGroup?: PromptGroupRecord | null;
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
    input: WithPromptFilters<{
      readonly groupId: string;
      readonly updates: unknown;
      readonly loadedGroup?: PromptGroupRecord | null;
    }>,
  ): Promise<PromptServiceResult<PromptGroupRecord>>;
  makePromptProduction(
    input: WithPromptFilters<{
      readonly promptId: string;
      readonly loadedRevision?: PromptRecord | null;
    }>,
  ): Promise<MakePromptProductionResult>;
  deletePrompt(input: {
    readonly groupId: string;
    readonly promptId: string;
    readonly loadedRevision?: PromptRecord | null;
  }): Promise<PromptServiceResult<TDeletePromptResponse>>;
  deletePromptGroup(input: {
    readonly groupId: string;
    readonly loadedGroup?: PromptGroupRecord | null;
    /** Reads the group's revision IDs after the read-only guard, for a caller that
     *  clears a per-revision cache once the group (and its revisions) are gone. */
    readonly collectPromptIds?: boolean;
  }): Promise<
    PromptServiceResult<{ readonly message: string; readonly promptIds?: readonly string[] }>
  >;
  /**
   * Finds-or-creates one source-pointer group by its source identity, granting a
   * PUBLIC viewer entry only when it was just created. A match is left as is: no
   * ACL write and no update statement run against an existing group. A failed
   * grant rolls the new group back and rethrows.
   */
  importSourceGroup(input: ImportSourceGroupInput): Promise<PromptSourceImportOutcome>;
}

function invalidInput<T>(message: string, details?: unknown): PromptServiceResult<T> {
  return { ok: false, error: { type: 'invalid_input', message, details } };
}

function unsupported(operation: PromptOperation): PromptServiceResult<never> {
  return { ok: false, error: { type: 'unsupported', operation } };
}

function readOnly(source: PromptGroupRecord['source']): PromptServiceResult<never> {
  return { ok: false, error: { type: 'read_only', source } };
}

/** A group whose source is not native is managed externally and rejects every
 *  mutation. A missing group is left to the write or read it guards; only a
 *  group that is known and external triggers the rejection. */
function isExternal(group: PromptGroupRecord): boolean {
  return group.source !== 'native';
}

function inspect(
  input: Parameters<typeof inspectPromptContent>[0],
  filters: FiltersConfig | undefined,
): { readonly ok: false; readonly error: PromptServiceError } | null {
  const finding = inspectPromptContent(input, filters);
  return finding == null ? null : { ok: false, error: { type: 'blocked_content', finding } };
}

/** Builds the prompt service from a store, source adapters and permission grants. */
export function createPromptServiceFromAdapters(adapters: PromptServiceAdapters): PromptService {
  const { store, sources, grantCreatorOwnership, grantPublicViewer, logger } = adapters;

  const readPrompt = (promptId: string, loaded?: PromptRecord | null) =>
    loaded?._id === promptId
      ? Promise.resolve(loaded)
      : withPromptStage('read', () => store.getPrompt(promptId));

  const readGroup = (groupId: string, loaded?: PromptGroupRecord | null) =>
    loaded?._id === groupId
      ? Promise.resolve(loaded)
      : withPromptStage('read', () => store.getPromptGroup(groupId));

  return {
    async resolvePrompt({
      groupId,
      selection,
      loadedGroup,
      loadedRevision,
      filters,
      allowedSources,
    }) {
      const group = await readGroup(groupId, loadedGroup);
      if (group == null) {
        return {
          ok: false,
          error: { type: 'unavailable_selection', reason: selectionUnavailableReason(selection) },
        };
      }
      if (allowedSources != null && !allowedSources.includes(group.source)) {
        return { ok: false, error: { type: 'unsupported_source', source: group.source } };
      }
      const adapter = sources[group.source];
      const resolved = await adapter.resolvePrompt({ group, selection, loadedRevision });
      if (!resolved.ok) {
        return resolved;
      }
      return inspect({ prompt: resolved.value.prompt }, filters) ?? resolved;
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
      const result = await store.getListPromptGroupsByAccess({
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
      // Keyed by groupId against the native `Prompt` collection: a Langfuse group has no
      // rows there, so this already resolves to `[]` for one without a source check.
      const prompts = await withPromptStage('read', () => store.getPrompts(groupId));
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
      // The client create path always produces a native group: source identity is set by
      // import flows, never by a request body. Drop these fields here regardless of what
      // the client sent, since the database layer upserts whatever `group` it is given.
      const {
        source: _clientSource,
        sourcePromptName: _clientSourcePromptName,
        sourceProjectId: _clientSourceProjectId,
        sourceDestination: _clientSourceDestination,
        ...group
      } = input.group as typeof input.group & {
        source?: unknown;
        sourcePromptName?: unknown;
        sourceProjectId?: unknown;
        sourceDestination?: unknown;
      };
      const rejection = inspect({ prompt: validation.data, group }, filters);
      if (rejection != null) {
        return rejection;
      }
      const value = await store.createPromptGroup({ ...input, group, prompt: validation.data });
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

    async savePrompt({ groupId, prompt, author, filters, loadedGroup }) {
      if (!store.savePrompt) {
        return unsupported('savePrompt');
      }
      if (!prompt) {
        return invalidInput('Prompt is required');
      }
      const group = await readGroup(groupId, loadedGroup);
      if (group != null && isExternal(group)) {
        return readOnly(group.source);
      }
      const validation = safeValidatePromptPayload(prompt);
      if (!validation.success) {
        return invalidInput(validation.error.issues[0]?.message ?? 'Invalid prompt');
      }
      const rejection = inspect({ prompt: validation.data }, filters);
      if (rejection != null) {
        return rejection;
      }
      const save = store.savePrompt;
      const value = await withPromptStage('write', () =>
        save({ groupId, prompt: validation.data, author }),
      );
      return { ok: true, value };
    },

    async getPromptGroup({ groupId, loadedGroup, filters }) {
      const group = await readGroup(groupId, loadedGroup);
      if (group == null) {
        return null;
      }
      return (
        inspect({ group }, filters) ?? {
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
      return inspect({ prompt: revision }, filters) ?? { ok: true, value: revision };
    },

    incrementPromptGroupUsage: (groupId) => store.incrementPromptGroupUsage(groupId),

    async updatePromptGroup({ groupId, updates, filters, loadedGroup }) {
      const group = await readGroup(groupId, loadedGroup);
      if (group != null && isExternal(group)) {
        return readOnly(group.source);
      }
      const validation = safeValidatePromptGroupUpdate(updates);
      if (!validation.success) {
        return invalidInput('Invalid request body', validation.error.issues);
      }
      const rejection = inspect({ group: validation.data }, filters);
      if (rejection != null) {
        return rejection;
      }
      const value = await withPromptStage('write', () =>
        store.updatePromptGroup(groupId, validation.data),
      );
      return { ok: true, value };
    },

    async makePromptProduction({ promptId, loadedRevision, filters }) {
      if (!store.makePromptProduction) {
        return unsupported('makePromptProduction');
      }
      const revision = await readPrompt(promptId, loadedRevision);
      if (revision != null) {
        const group = await readGroup(revision.groupId);
        if (group != null && isExternal(group)) {
          return readOnly(group.source);
        }
      }
      const rejection = inspect({ prompt: revision ?? undefined }, filters);
      if (rejection != null) {
        return rejection;
      }
      const promote = store.makePromptProduction;
      const value = await withPromptStage('write', () => promote(promptId));
      return { ok: true, value, groupId: revision?.groupId };
    },

    async deletePrompt(input) {
      if (!store.deletePrompt) {
        return unsupported('deletePrompt');
      }
      const revision = await readPrompt(input.promptId, input.loadedRevision);
      if (revision != null) {
        const group = await readGroup(revision.groupId);
        if (group != null && isExternal(group)) {
          return readOnly(group.source);
        }
      }
      return { ok: true, value: await store.deletePrompt(input) };
    },

    async deletePromptGroup({ groupId, loadedGroup, collectPromptIds }) {
      const group = await readGroup(groupId, loadedGroup);
      if (group != null && isExternal(group)) {
        return readOnly(group.source);
      }
      // Revisions are gone once the group is deleted, so their IDs are read here, after
      // the guard, while they still exist. A read failure is logged and left empty
      // rather than blocking the delete; exact-revision cache entries then expire by TTL.
      let promptIds: readonly string[] | undefined;
      if (collectPromptIds) {
        try {
          promptIds = (await withPromptStage('read', () => store.getPrompts(groupId))).map(
            (revision) => revision._id,
          );
        } catch (error) {
          logger.error('[deletePromptGroup] Failed to read revisions for group', {
            groupId,
            ...getSafeErrorMetadata(error),
          });
          promptIds = [];
        }
      }
      const value = await store.deletePromptGroup(groupId);
      return { ok: true, value: promptIds == null ? value : { ...value, promptIds } };
    },

    async importSourceGroup({ identity, name, author, authorName }) {
      // Insertion and the initial PUBLIC grant are separate writes. If a run stops between
      // them, a later import leaves the existing group unchanged and does not retry the grant.
      const existing = await store.findSourceGroup(identity);
      if (existing) {
        return 'unchanged';
      }

      const created = await store.createSourceGroup({ identity, name, author, authorName });
      if (!created.ok) {
        if (created.error.code === 'duplicate') {
          return 'unchanged';
        }
        logger.warn('[importSourceGroup] Skipped a source group that failed validation', {
          name,
          code: 'invalid',
          ...getSafeErrorMetadata(created.error.cause),
        });
        return 'skipped';
      }

      const groupId = created.value._id;
      try {
        await grantPublicViewer({ groupId });
      } catch (error) {
        logger.error(
          '[importSourceGroup] Could not grant public access to an imported source group',
          { groupId, ...getSafeErrorMetadata(error) },
        );
        try {
          await store.deletePromptGroup(groupId);
        } catch (deleteError) {
          logger.error('[importSourceGroup] Could not roll back an ungranted source group', {
            groupId,
            ...getSafeErrorMetadata(deleteError),
          });
        }
        throw error;
      }

      return 'created';
    },
  };
}

export interface PromptServiceDependencies {
  readonly db: PromptDatabase;
  readonly grantPermission: (input: {
    principalType: PrincipalType;
    principalId: string | null;
    resourceType: ResourceType;
    resourceId: string;
    accessRoleId: AccessRoleIds;
    grantedBy: string;
  }) => Promise<unknown>;
  /** Reads the app config a Langfuse content read resolves against. Configuration —
   *  the deployment gate, the tenant's prompt-sync switch, and whether a connection
   *  can be built from it — decides at request time whether a Langfuse group's
   *  `resolvePrompt` reaches Langfuse or returns `source_unavailable`; the caller
   *  never decides whether Langfuse exists. */
  readonly getAppConfig: CreateLangfuseSourceResolverDeps['getAppConfig'];
}

/**
 * Builds the prompt service from the LibreChat database methods and permission service.
 * Every prompt source LibreChat supports has an adapter here, including Langfuse:
 * `getAppConfig` builds its source resolver, which reads the deployment's base config
 * through `db.findConfigByPrincipal`. Configuration, not the caller, decides whether a
 * Langfuse group's `resolvePrompt` reaches Langfuse or returns
 * `source_unavailable{reason:'disabled'|'not_configured'|'source_changed'}`.
 */
export function createPromptService({
  db,
  grantPermission,
  getAppConfig,
}: PromptServiceDependencies): PromptService {
  const store = createPromptStore(db);
  return createPromptServiceFromAdapters({
    store,
    sources: {
      native: createNativePromptAdapter(store),
      langfuse: createLangfusePromptAdapter({
        resolveSource: createLangfuseSourceResolver({
          findBaseConfig: () =>
            db.findConfigByPrincipal(PrincipalType.ROLE, BASE_CONFIG_PRINCIPAL_ID),
          getAppConfig,
        }),
      }),
    },
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
    grantPublicViewer: async ({ groupId }) => {
      await grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.PROMPTGROUP,
        resourceId: groupId,
        accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
        grantedBy: CONSTANTS.SYSTEM_USER_ID,
      });
    },
    logger,
  });
}
