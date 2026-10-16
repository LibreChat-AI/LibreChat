import { PrincipalType, ResourceType, AccessRoleIds } from 'librechat-data-provider';
import type { PromptMethods } from '@librechat/data-schemas';
import type {
  PromptCatalogSyncDeps,
  PromptCatalogSyncResult,
  PromptCatalogSyncSource,
} from './promptCatalogSync';
import type { DistributedLock } from '~/cache/lock';
import { syncLangfusePromptCatalog } from './promptCatalogSync';
import { CONSTANTS } from '~/mcp/enum';

/** Process-lifetime dependencies: the shared lock, the Mongo-backed prompt
 *  group methods, the ACL grant and the logger. */
export interface LangfusePromptSyncRunnerDeps {
  lock: DistributedLock;
  findLangfusePromptGroup: PromptMethods['findLangfusePromptGroup'];
  createLangfusePromptGroup: PromptMethods['createLangfusePromptGroup'];
  deletePromptGroup: PromptMethods['deletePromptGroup'];
  grantPermission: (params: {
    principalType: PrincipalType;
    principalId: string | null;
    resourceType: ResourceType;
    resourceId: string;
    accessRoleId: string;
    grantedBy: string;
  }) => Promise<unknown>;
  logger: PromptCatalogSyncDeps['logger'];
}

/** Per-request inputs: the source identity, a connection-bound page lister
 *  and the config-resolved lock lease and page cap. */
export interface LangfusePromptSyncRequest {
  source: PromptCatalogSyncSource;
  listPrompts: PromptCatalogSyncDeps['listPrompts'];
  lockLeaseMs: number;
  maxPages: number;
}

export type LangfusePromptSyncRunner = (
  request: LangfusePromptSyncRequest,
) => Promise<PromptCatalogSyncResult>;

/** The AI-2272 partial unique index is defense in depth: this maps the
 *  resulting duplicate-key race to the runner's `unchanged` outcome. */
function isDuplicateKeyError(error: unknown): boolean {
  return (error as { code?: number } | undefined)?.code === 11000;
}

/** A document validation failure on `createLangfusePromptGroup`, mapped to the
 *  runner's `skipped` outcome. */
function isValidationError(error: unknown): boolean {
  return error instanceof Error && error.name === 'ValidationError';
}

/** Binds the storage-agnostic `syncLangfusePromptCatalog` to the Mongo-backed
 *  prompt-group methods and the ACL grant, so the Mongo error predicates live
 *  here and `promptCatalogSync.ts` stays storage-agnostic. Every new group is
 *  granted a PUBLIC `PROMPTGROUP_VIEWER` entry by the system user; a failed
 *  grant deletes the group again before the error propagates. */
export function createLangfusePromptSyncRunner(
  deps: LangfusePromptSyncRunnerDeps,
): LangfusePromptSyncRunner {
  const {
    lock,
    findLangfusePromptGroup,
    createLangfusePromptGroup,
    deletePromptGroup,
    grantPermission,
    logger,
  } = deps;

  return async function syncPromptCatalog({ source, listPrompts, lockLeaseMs, maxPages }) {
    const syncDeps: PromptCatalogSyncDeps = {
      listPrompts,
      findPromptGroup: findLangfusePromptGroup,
      createPromptGroup: createLangfusePromptGroup,
      isDuplicateKeyError,
      isValidationError,
      grantPublicViewer: async (groupId) => {
        await grantPermission({
          principalType: PrincipalType.PUBLIC,
          principalId: null,
          resourceType: ResourceType.PROMPTGROUP,
          resourceId: groupId,
          accessRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
          grantedBy: CONSTANTS.SYSTEM_USER_ID,
        });
      },
      deletePromptGroup: async (groupId) => {
        await deletePromptGroup({ _id: groupId });
      },
      lock,
      lockLeaseMs,
      maxPages,
      logger,
    };

    return syncLangfusePromptCatalog(source, syncDeps);
  };
}
