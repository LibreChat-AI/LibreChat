import type { TCheckpointerConfig } from 'librechat-data-provider';
import type { IMongoFile } from '@librechat/data-schemas';
import type { AdminErasureContext, AdminErasureTarget } from '~/admin/users';
import type { UserErasureDeps, MCPOAuthErasureHooks } from './erasure';
import type { FileDeletionOutcome } from '../files/deletion';
import type { MCPServerLookupOptions } from '~/mcp/types';

type ErasureBaseDeps = Omit<
  UserErasureDeps,
  | 'openCheckpointDeletion'
  | 'deleteSharedLinks'
  | 'deleteStoredFiles'
  | 'invalidateMCPServerTools'
  | 'disconnectMCPServer'
  | 'mcpOAuth'
>;

/** The stored-file fields deletion reads, without the document members of the persisted model. */
export type ErasureFile = Pick<
  IMongoFile,
  'file_id' | 'filepath' | 'filename' | 'source' | 'type' | 'bytes' | 'embedded' | 'temp_file_id'
>;

export interface ErasureResolverDeps {
  /** Runs an operation in the given tenant's data scope, or system scope when it has none. */
  withTenant: <T>(tenantId: string | undefined, operation: () => Promise<T>) => Promise<T>;
  /** Shared-server OAuth cleanup is wired only when the host has an MCP OAuth runtime. */
  mcpOAuth?: {
    getRegistry: () => {
      getServerConfig: (
        serverName: string,
        userId: string,
        configServers: undefined,
        role: undefined,
        options: MCPServerLookupOptions,
      ) => ReturnType<NonNullable<MCPOAuthErasureHooks['getServerConfig']>>;
      resolveAllowlists: (options: {
        userId: string;
      }) => ReturnType<MCPOAuthErasureHooks['resolveAllowlists']>;
    };
    getUserPrincipals: (params: {
      userId: string;
    }) => ReturnType<MCPOAuthErasureHooks['getUserPrincipals']>;
    uninstallOAuthMCP: MCPOAuthErasureHooks['uninstallOAuthMCP'];
  };
  /** Data-layer methods used by the cascade. */
  db: ErasureBaseDeps;
  getAppConfig: (options: {
    role?: string;
    userId: string;
    tenantId?: string;
    idOnTheSource?: string | null;
    failClosed?: boolean;
  }) => Promise<{ endpoints?: { agents?: { checkpointer?: TCheckpointerConfig } } } | undefined>;
  processDeleteRequest: (params: {
    req: Record<string, unknown>;
    files: ErasureFile[];
  }) => Promise<Required<FileDeletionOutcome>>;
  invalidateCachedTools: (params: { userId: string; serverName: string }) => Promise<unknown>;
  getMCPManager: () =>
    | { disconnectUserConnection: (userId: string, serverName: string) => Promise<unknown> }
    | null
    | undefined;
  openCheckpointDeletion: UserErasureDeps['openCheckpointDeletion'];
  deleteSharedLinks: UserErasureDeps['deleteSharedLinks'];
}

/**
 * Builds the `eraseUserData` dependencies for an account deleted by someone else. Stored files
 * are removed with a request that carries the target user, since provider clients and
 * credentials are resolved from the request user, not the calling admin.
 */
export function createErasureResolver(deps: ErasureResolverDeps) {
  return async function resolveErasure({
    id,
    role,
    tenantId,
    idOnTheSource,
    profile,
  }: AdminErasureTarget): Promise<AdminErasureContext> {
    /** The calling admin's tenant context must not decide whose rows an id-keyed lookup reads. */
    const inTargetTenant = <T>(operation: () => Promise<T>): Promise<T> =>
      deps.withTenant(tenantId, operation);
    /** A failed override lookup must abort the deletion, not fall back to a base config that cannot reach the target's storage. */
    const appConfig = await inTargetTenant(async () =>
      deps.getAppConfig({
        role,
        userId: id,
        tenantId,
        idOnTheSource,
        failClosed: true,
      }),
    );
    const oauth = deps.mcpOAuth;
    const fileRequest = {
      user: { ...profile, id, _id: id, role, tenantId },
      /** Assistants client setup reads these Express request fields. */
      baseUrl: '',
      query: {},
      body: {},
      config: appConfig,
    };
    return {
      checkpointer: appConfig?.endpoints?.agents?.checkpointer,
      deps: {
        ...deps.db,
        openCheckpointDeletion: deps.openCheckpointDeletion,
        deleteSharedLinks: deps.deleteSharedLinks,
        deleteUserAgents: (userId) => inTargetTenant(async () => deps.db.deleteUserAgents(userId)),
        findMCPServerOAuthTokenUserIds: (serverName) =>
          inTargetTenant(async () => deps.db.findMCPServerOAuthTokenUserIds(serverName)),
        findMCPServerViewerEntries: (serverId) =>
          inTargetTenant(async () => deps.db.findMCPServerViewerEntries(serverId)),
        deleteStoredFiles: (files) =>
          inTargetTenant(async () => deps.processDeleteRequest({ req: fileRequest, files })),
        invalidateMCPServerTools: (serverName) =>
          deps.invalidateCachedTools({ userId: id, serverName }),
        disconnectMCPServer: async (serverName) => {
          await deps.getMCPManager()?.disconnectUserConnection(id, serverName);
        },
        mcpOAuth: oauth && {
          getServerConfig: (serverName) =>
            inTargetTenant(async () =>
              oauth
                .getRegistry()
                .getServerConfig(serverName, id, undefined, undefined, { includeHidden: true }),
            ),
          getUserPrincipals: (candidateId) =>
            inTargetTenant(async () => oauth.getUserPrincipals({ userId: candidateId })),
          resolveAllowlists: (candidateId) =>
            inTargetTenant(async () =>
              oauth.getRegistry().resolveAllowlists({ userId: candidateId }),
            ),
          uninstallOAuthMCP: (candidateId, pluginKey, cleanupConfig, serverConfig) =>
            inTargetTenant(async () =>
              oauth.uninstallOAuthMCP(candidateId, pluginKey, cleanupConfig, serverConfig),
            ),
          invalidateUserTools: (candidateId, serverName) =>
            inTargetTenant(async () =>
              deps.invalidateCachedTools({ userId: candidateId, serverName }),
            ),
          disconnectUser: (candidateId, serverName) =>
            inTargetTenant(async () =>
              deps.getMCPManager()?.disconnectUserConnection(candidateId, serverName),
            ),
        },
      },
    };
  };
}
