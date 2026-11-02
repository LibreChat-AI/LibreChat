import mongoose from 'mongoose';
import { logger } from '@librechat/data-schemas';
import type { TCheckpointerConfig, MCPOptions } from 'librechat-data-provider';
import type { AllMethods, IMongoFile } from '@librechat/data-schemas';
import type {
  OAuthAclSubject,
  MCPOAuthRetainedFence,
  MCPOAuthTeardownOptions,
} from '../mcp/oauth/cleanup';
import type { CheckpointDeletion } from '~/agents/checkpoints/deletion';
import type { FileDeletionOutcome } from '../files/deletion';
import {
  cleanupDeletedMCPServerOAuthUsers,
  prepareMCPServerOAuthDeletion,
} from '../mcp/oauth/cleanup';

type ErasureMethods = Pick<
  AllMethods,
  | 'deleteConvos'
  | 'deleteMessages'
  | 'deleteAllUserSessions'
  | 'deletePasskeysByUser'
  | 'deleteTransactions'
  | 'deleteUserKey'
  | 'deleteBalances'
  | 'deletePresets'
  | 'deleteAllUserPluginAuths'
  | 'getFiles'
  | 'deleteFiles'
  | 'deleteToolCalls'
  | 'deleteUserAgents'
  | 'deleteAllAgentApiKeys'
  | 'deleteAssistants'
  | 'deleteConversationTags'
  | 'deleteAllUserMemories'
  | 'deleteUserPrompts'
  | 'deleteUserSkills'
  | 'findUserErasableMCPServers'
  | 'deleteMCPServersWithAcl'
  | 'findMCPServerOAuthTokenUserIds'
  | 'findMCPServerViewerEntries'
  | 'findMCPServerViewerUserIds'
  | 'deleteActions'
  | 'deleteTokens'
  | 'removeUserFromAllGroups'
  | 'deleteAclEntries'
  | 'deleteSchedulesByUser'
  | 'deleteUserChatProjects'
  | 'deleteUserToolFavorites'
  | 'deleteRefreshTokenBridges'
  | 'deleteAllAgentQueuedTurnsForUser'
>;

export interface UserErasureDeps extends ErasureMethods {
  openCheckpointDeletion: (
    userId: string,
    tenantId: string | undefined,
    rootConversationId: string | undefined,
    cfg?: TCheckpointerConfig,
  ) => Promise<CheckpointDeletion>;
  deleteSharedLinks: (userId: string) => Promise<unknown>;
  /** Removes stored file objects (local disk, S3, Firebase, vector store) before their metadata. */
  deleteStoredFiles: (files: IMongoFile[]) => Promise<Required<FileDeletionOutcome>>;
  /** Runtime cleanup for a removed MCP server; each hook is best effort. */
  invalidateMCPServerTools?: (serverName: string) => Promise<unknown>;
  disconnectMCPServer?: (serverName: string) => Promise<unknown>;
  /**
   * Cleans OAuth credentials, cached catalogs and connections of every user a removed MCP server
   * was shared with. Omitted when the host has no OAuth runtime; the owner hooks above still run.
   */
  mcpOAuth?: MCPOAuthErasureHooks;
  /** Runs once the user's sessions are revoked, before the rest of the cascade can fail. */
  onSessionsDeleted?: () => void;
}

export interface MCPOAuthErasureHooks {
  /** Config of the server before it is removed, so stored tokens can still be revoked. */
  getServerConfig?: (serverName: string, serverId: string) => Promise<MCPOptions | undefined>;
  getUserPrincipals: (userId: string) => Promise<OAuthAclSubject[]>;
  resolveAllowlists: (
    userId: string,
  ) => Promise<{ allowedDomains?: string[] | null; allowedAddresses?: string[] | null }>;
  /** Bumps the user's cached catalog generation for the server so loaded tools stop working. */
  invalidateUserTools?: (userId: string, serverName: string) => Promise<unknown>;
  /** Closes the user's live connection to the server, where the host holds connections. */
  disconnectUser?: (userId: string, serverName: string) => Promise<unknown>;
  uninstallOAuthMCP: (
    userId: string,
    pluginKey: string,
    appConfig: {
      mcpSettings?: { allowedDomains?: string[] | null; allowedAddresses?: string[] | null };
    },
    serverConfig?: MCPOptions,
    teardown?: MCPOAuthTeardownOptions,
  ) => Promise<void>;
}

export interface UserErasureParams {
  userId: string;
  tenantId?: string;
  checkpointer?: TCheckpointerConfig;
  /** Operator option to keep the transaction ledger; account self-deletion always erases it. */
  keepTransactions?: boolean;
}

export type MCPServerCleanupDeps = Pick<
  UserErasureDeps,
  | 'findUserErasableMCPServers'
  | 'deleteMCPServersWithAcl'
  | 'invalidateMCPServerTools'
  | 'disconnectMCPServer'
  | 'findMCPServerOAuthTokenUserIds'
  | 'findMCPServerViewerEntries'
  | 'findMCPServerViewerUserIds'
  | 'mcpOAuth'
>;

/**
 * Deletes MCP servers solely owned by the user, plus legacy (pre-ACL) servers that only carry
 * the author field, and their ACL entries. Servers with other owners are left intact; the
 * user's own principal ACL entries are removed separately by the cascade. Runtime hooks are
 * best effort; a database failure propagates so the caller keeps the account and can retry.
 */
export async function deleteUserMCPServers(
  userId: string,
  deps: MCPServerCleanupDeps,
  tenantId?: string,
): Promise<void> {
  const servers = await deps.findUserErasableMCPServers(userId);
  if (servers.length === 0) {
    return;
  }

  await Promise.allSettled(
    servers.map(async ({ serverName }) => {
      if (!serverName) {
        return;
      }
      try {
        await deps.invalidateMCPServerTools?.(serverName);
      } catch (error) {
        logger.warn(`[eraseUserData] Failed to invalidate tools for ${serverName}`, error);
      } finally {
        try {
          await deps.disconnectMCPServer?.(serverName);
        } catch (error) {
          logger.warn(`[eraseUserData] Failed to disconnect ${serverName}`, error);
        }
      }
    }),
  );

  const oauth = deps.mcpOAuth;
  const named = servers.filter((server) => server.serverName);
  /** Shared users are discovered from the ACLs and tokens, which the delete removes. */
  const prepared = oauth
    ? await Promise.all(
        named.map(async ({ id, serverName }) => ({
          serverName,
          serverConfig: await oauth.getServerConfig?.(serverName, id),
          snapshot: await prepareMCPServerOAuthDeletion({
            getTokenUserIds: () => deps.findMCPServerOAuthTokenUserIds(serverName, tenantId),
            getAclEntries: () => deps.findMCPServerViewerEntries(id),
            getViewerUserIds: deps.findMCPServerViewerUserIds,
          }),
        })),
      )
    : [];

  /** Each user's OAuth fence stays held until the delete commits, so no authorization or refresh
   * can persist credentials between the cleanup and the removal of the retry anchor. */
  const fences: MCPOAuthRetainedFence[] = [];
  const cleanupSharedUsers = async (removed: typeof prepared): Promise<number> => {
    if (!oauth) {
      return 0;
    }
    const results = await Promise.allSettled(
      removed.map(({ serverName, serverConfig, snapshot }) =>
        cleanupDeletedMCPServerOAuthUsers({
          ownerUserId: userId,
          serverName,
          serverConfig,
          snapshot,
          getTokenUserIds: () => deps.findMCPServerOAuthTokenUserIds(serverName, tenantId),
          getUserPrincipals: oauth.getUserPrincipals,
          resolveAllowlists: oauth.resolveAllowlists,
          fenceAndDisconnectUser: async (candidateId) => {
            await oauth.invalidateUserTools?.(candidateId, serverName);
            await oauth.disconnectUser?.(candidateId, serverName);
          },
          uninstallOAuthMCP: oauth.uninstallOAuthMCP,
          strictRevocation: true,
          retainFence: (fence) => fences.push(fence),
        }),
      ),
    );
    let failures = 0;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failures++;
        logger.error(`[eraseUserData] MCP OAuth cleanup failed for user ${userId}`, result.reason);
        return;
      }
      /** Local state is gone; the operator needs to know which provider grants may remain. */
      for (const refusal of result.value) {
        logger.error(
          `[eraseUserData] OAuth provider for MCP server ${removed[index].serverName} did not revoke the ${refusal.tokenTypes.join(' and ')} token of user ${refusal.userId}; the external grant may remain valid`,
        );
      }
    });
    return failures;
  };

  try {
    /** The server and its ACLs are the retry anchors, so they outlive a failed teardown. */
    if ((await cleanupSharedUsers(prepared)) > 0) {
      throw new Error('MCP OAuth cleanup failed for users of a server being removed');
    }
    /** A large teardown can outlive a lease; one that lapsed may have let a writer through. */
    const renewed = await Promise.all(fences.map((fence) => fence.renew()));
    if (renewed.includes(false)) {
      throw new Error('An MCP OAuth teardown fence lapsed before the server was removed');
    }
    await deps.deleteMCPServersWithAcl(servers.map((s) => s.id));
  } finally {
    const releases = await Promise.allSettled(fences.map((fence) => fence.release()));
    for (const result of releases) {
      if (result.status === 'rejected') {
        logger.warn('[eraseUserData] Failed to release an MCP OAuth teardown fence', result.reason);
      }
    }
  }
}

/**
 * Waits for independent deletes to settle, then rethrows the first failure in declaration
 * order, so a failed step aborts the erasure with the same error as when they ran one by one.
 */
async function settleInOrder(steps: Array<Promise<unknown> | undefined>): Promise<void> {
  const results = await Promise.allSettled(steps);
  for (const result of results) {
    if (result.status === 'rejected') {
      throw result.reason;
    }
  }
}

/**
 * The user-owned data cascade shared by account self-deletion and the operator CLI.
 *
 * Callers own everything around it: deletion fences, schedule suspension, generation aborts,
 * the final user document delete, and code environment cleanup after that commit. The cascade
 * is idempotent, so a failed attempt can be retried after the caller restores its fences.
 */
export async function eraseUserData(
  params: UserErasureParams,
  deps: UserErasureDeps,
): Promise<void> {
  const { userId, tenantId, checkpointer, keepTransactions = false } = params;
  const userObjectId = new mongoose.Types.ObjectId(userId);

  const checkpointDeletion = await deps.openCheckpointDeletion(
    userId,
    tenantId,
    undefined,
    checkpointer,
  );
  await deps.deleteConvos(
    userId,
    {},
    {
      allowEmpty: true,
      beforeDelete: (ids) => checkpointDeletion.remember(ids),
    },
  );
  await checkpointDeletion.cleanup();
  await checkpointDeletion.acknowledge();

  await deps.deleteUserChatProjects(userId);
  await deps.deleteMessages({ user: userId });
  await deps.deleteAllAgentQueuedTurnsForUser({ user: userObjectId });
  /** Before user keys: provider-stored files need the user's own assistants credentials. */
  const files = await deps.getFiles({ user: userId });
  const outcome = await deps.deleteStoredFiles(files ?? []);
  const deleted = new Set(outcome.deletedFileIds);
  if (outcome.failedFileIds.length > 0 || files?.some((file) => !deleted.has(file.file_id))) {
    throw new Error('Stored file deletion incomplete');
  }
  await deps.deleteFiles([...deleted], undefined, { files: files ?? [], userId });
  if ((await deps.getFiles({ user: userId }, undefined, { _id: 1 }, 1))?.length) {
    throw new Error('Stored file deletion incomplete');
  }
  await deps.deleteAllUserSessions({ userId });
  deps.onSessionsDeleted?.();
  await deps.deleteRefreshTokenBridges({ userId, tenantId });
  if (tenantId) {
    /** Bridges written before tenancy carry no tenantId, and the user id is globally unique. */
    await deps.deleteRefreshTokenBridges({ userId });
  }
  await deps.deletePasskeysByUser(userId);
  await deps.deleteUserKey({ userId, all: true });
  /** Leaf collections nothing later in the erasure reads, so they are removed together. */
  await settleInOrder([
    keepTransactions ? undefined : deps.deleteTransactions({ user: userId }),
    deps.deleteBalances({ user: userObjectId }),
    deps.deletePresets(userId),
    deps.deleteAllUserPluginAuths(userId),
    deps.deleteToolCalls(userId),
    deps.deleteConversationTags({ user: userId }),
    deps.deleteUserToolFavorites(userId),
    deps.deleteAllUserMemories(userId),
  ]);
  await deps.deleteSharedLinks(userId);
  await deps.deleteUserAgents(userId);
  await deps.deleteAllAgentApiKeys(userObjectId);
  await deps.deleteAssistants({ user: userId });
  await deps.deleteUserPrompts(userId);
  await deps.deleteUserSkills(userId);
  await deleteUserMCPServers(userId, deps, tenantId);
  await deps.deleteActions({ user: userId });
  await deps.deleteTokens({ userId });
  await deps.removeUserFromAllGroups(userId);
  await deps.deleteAclEntries({ principalId: userObjectId });
  await deps.deleteSchedulesByUser(userId);
}
