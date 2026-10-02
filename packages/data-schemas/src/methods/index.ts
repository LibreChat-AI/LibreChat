import type { RoleMethods, RoleDeps } from './role';
import {
  createOpenIDRefreshFlightMethods,
  type OpenIDRefreshFlightMethods,
} from './openidRefreshFlight';
export {
  createMCPAuthorizationFenceRetryStorage,
  type MCPAuthorizationFenceRetryStorage,
} from './mcpAuthorizationFenceRetry';
import {
  createRefreshTokenBridgeMethods,
  type RefreshTokenBridgeMethods,
} from './refreshTokenBridge';
import { createSessionMethods, DEFAULT_REFRESH_TOKEN_EXPIRY, type SessionMethods } from './session';
import { createUserMethods, DEFAULT_SESSION_EXPIRY, type UserMethods } from './user';
import { createFileMethods, type FileMethods, type FileOwnerScope } from './file';
import { createTokenMethods, type TokenMethods } from './token';
import { createRoleMethods, RoleConflictError } from './role';
import { createKeyMethods, type KeyMethods } from './key';
/* Memories */
import { createMemoryMethods, type MemoryMethods } from './memory';
/* Tool Favorites */
import {
  createToolFavoriteMethods,
  MAX_TOOL_FAVORITES,
  type ToolFavoriteMethods,
} from './favorite';
/* Agent Categories */
import { createAgentCategoryMethods, type AgentCategoryMethods } from './agentCategory';
/* Agent API Keys */
import { createAgentApiKeyMethods, type AgentApiKeyMethods } from './agentApiKey';
/* MCP Servers */
import { createMCPServerMethods, type MCPServerMethods } from './mcpServer';
import { createCodeEnvironmentMethods, type CodeEnvironmentMethods } from './codeEnvironment';
/* Plugin Auth */
import { createPluginAuthMethods, type PluginAuthMethods } from './pluginAuth';
/* Permissions */
import { createAccessRoleMethods, type AccessRoleMethods } from './accessRole';
import {
  createUserGroupMethods,
  runAfterTransaction,
  type UserGroupMethods,
  type UserGroupDeps,
} from './userGroup';
import {
  createAclEntryMethods,
  permissionBitSupersets,
  PERM_BITS_WRITE_ATTEMPTS,
  type AclEntryMethods,
} from './aclEntry';
import { createSystemGrantMethods, type SystemGrantMethods } from './systemGrant';
import {
  createAuditLogMethods,
  AUDIT_SCHEMA_VERSION,
  MAX_AUDIT_EXPORT_ROWS,
  MAX_AUDIT_LOG_LIMIT,
  MAX_AUDIT_VERIFY_ROWS,
  type AuditLogMethods,
} from './auditLog';
import { createShareMethods, type ShareMethods } from './share';
/* Tier 1 — Simple CRUD */
import { createActionMethods, type ActionMethods } from './action';
import { createAssistantMethods, type AssistantMethods } from './assistant';
import { createBannerMethods, type BannerMethods } from './banner';
import { createToolCallMethods, type ToolCallMethods } from './toolCall';
import { createCategoriesMethods, type CategoriesMethods } from './categories';
import { createPresetMethods, type PresetMethods } from './preset';
/* Tier 2 — Moderate (service deps injected) */
import { createConversationTagMethods, type ConversationTagMethods } from './conversationTag';
import { createConversationImportMethods, type ConversationImportMethods } from './import';
import {
  createMessageMethods,
  CLIENT_MESSAGE_SELECT,
  SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT,
  type MessageMethods,
  type ParentSubagentTaskRecord,
  type SubagentThreadViewMessageRecord,
  type SubagentTaskResultClaim,
  type BackgroundToolResultClaim,
  type BackgroundToolResultRecord,
  type ConversationTraceRefs,
  type SampledTraceMessage,
} from './message';
import {
  createConversationMethods,
  type AgentEventActorReconciliationStorageMetrics,
  type ConversationMethods,
  type ParentSubagentThreadRecord,
} from './conversation';
import { createChatProjectMethods, type ChatProjectMethods } from './chatProject';
export type {
  AssignConversationToProjectResult,
  ChatProjectSortBy,
  ChatProjectSortDirection,
  CreateChatProjectInput,
  DeleteChatProjectResult,
  ListChatProjectsOptions,
  ListChatProjectsResult,
  UpdateChatProjectInput,
} from './chatProject';
/* Tier 3 — Complex (heavier injection) */
import {
  createTxMethods,
  type TxMethods,
  type TxDeps,
  tokenValues,
  cacheTokenValues,
  premiumTokenValues,
  defaultRate,
} from './tx';
import { createTransactionMethods, type TransactionMethods } from './transaction';
import { createSpendTokensMethods, type SpendTokensMethods } from './spendTokens';
import { createPromptMethods, type PromptMethods, type PromptDeps } from './prompt';
import {
  createSkillMethods,
  partitionIssues,
  validateSkillName,
  validateSkillBody,
  validateRelativePath,
  validateSkillFrontmatter,
  getCanonicalSkillFrontmatterKey,
  normalizeSkillFrontmatterKeys,
  validateSkillDescription,
  deriveStructuredFrontmatterFields,
  inferSkillFileCategory,
  type SkillMethods,
  type SkillDeps,
  type CreateSkillInput,
  type CreateSkillResult,
  type UpdateSkillInput,
  type UpsertSkillFileInput,
  type ListSkillsByAccessParams,
  type ListSkillsByAccessResult,
  type UpdateSkillResult,
  type ValidationIssue,
  type DeleteSkillCleanupStep,
  type DeleteSkillResult,
} from './skill';
import { createScheduleMethods, type ScheduleMethods } from './schedule';
import {
  createAgentQueuedTurnMethods,
  AgentQueuedTurnCapacityError,
  AgentQueuedTurnConflictError,
  AgentQueuedTurnLaneRetiredError,
  type AgentQueuedTurnMethods,
} from './queuedTurn';
import {
  createAgentTriggerDeliveryMethods,
  AgentTriggerDeliveryConflictError,
  recordAgentEventActorReceiptMetric,
  setAgentEventActorReceiptMetricObserver,
  type AgentTriggerDeliveryMethods,
  type AgentTriggerProducerLeaseStatus,
  type AgentEventActorReceiptMetric,
  type AgentEventActorReceiptStorageMetrics,
} from './triggerDelivery';
import { createSkillSyncMethods, type SkillSyncMethods } from './skillSync';
import type {
  SkillSyncStatusInput,
  SkillSyncCredentialSummary,
  UpsertSkillSyncCredentialInput,
} from './skillSync';
/* Tier 5 — Agent */
import {
  createAgentMethods,
  type AgentMethods,
  type AgentDeps,
  type AgentGraphNode,
  type AgentGraphAccess,
  type AgentGraphAccessContext,
} from './agent';
/* Config */
import { createConfigMethods, type ConfigMethods } from './config';
import {
  createMCPAuthorityMethods,
  MCPAuthorityProofError,
  MAX_MCP_AUTHORITY_TARGETS,
  createMCPAuthorityBootRevision,
  createMCPAuthorityConfigSourceRevision,
  createMCPAuthorityCredentialRevision,
  createMCPAuthorityDatabaseSourceRevision,
  digestMCPAuthorityValue,
  type MCPAuthorityMethods,
  type MCPAuthorityMethodHooks,
  type MCPAuthorityConfigSourceDocument,
  type MCPAuthorityCredentialSourceDocument,
} from './mcpAuthority';
/* Insights */
import { createInsightsMethods, type InsightsMethods } from './insights';

export {
  runAfterTransaction,
  RoleConflictError,
  MCPAuthorityProofError,
  MAX_MCP_AUTHORITY_TARGETS,
  DEFAULT_REFRESH_TOKEN_EXPIRY,
  DEFAULT_SESSION_EXPIRY,
  createMCPAuthorityBootRevision,
  createMCPAuthorityConfigSourceRevision,
  createMCPAuthorityCredentialRevision,
  createMCPAuthorityDatabaseSourceRevision,
  digestMCPAuthorityValue,
};
export { tokenValues, cacheTokenValues, premiumTokenValues, defaultRate, createTxMethods };
export { permissionBitSupersets, PERM_BITS_WRITE_ATTEMPTS };
export { CLIENT_MESSAGE_SELECT, SUBAGENT_TRANSCRIPT_SOURCE_BYTE_LIMIT };
export {
  partitionIssues,
  validateSkillName,
  validateSkillBody,
  validateRelativePath,
  validateSkillFrontmatter,
  getCanonicalSkillFrontmatterKey,
  normalizeSkillFrontmatterKeys,
  validateSkillDescription,
  deriveStructuredFrontmatterFields,
  inferSkillFileCategory,
};
export { AUDIT_SCHEMA_VERSION, MAX_AUDIT_EXPORT_ROWS, MAX_AUDIT_LOG_LIMIT, MAX_AUDIT_VERIFY_ROWS };
export { MAX_TOOL_FAVORITES };
export { AgentTriggerDeliveryConflictError };
export {
  AgentQueuedTurnCapacityError,
  AgentQueuedTurnConflictError,
  AgentQueuedTurnLaneRetiredError,
};

export type AllMethods = UserMethods &
  SessionMethods &
  TokenMethods &
  RefreshTokenBridgeMethods &
  OpenIDRefreshFlightMethods &
  RoleMethods &
  KeyMethods &
  FileMethods &
  MemoryMethods &
  ToolFavoriteMethods &
  AgentCategoryMethods &
  AgentApiKeyMethods &
  MCPServerMethods &
  CodeEnvironmentMethods &
  UserGroupMethods &
  AclEntryMethods &
  SystemGrantMethods &
  AuditLogMethods &
  ShareMethods &
  AccessRoleMethods &
  PluginAuthMethods &
  ActionMethods &
  AssistantMethods &
  BannerMethods &
  ToolCallMethods &
  CategoriesMethods &
  PresetMethods &
  ConversationTagMethods &
  ConversationImportMethods &
  MessageMethods &
  ConversationMethods &
  ChatProjectMethods &
  TxMethods &
  TransactionMethods &
  SpendTokensMethods &
  PromptMethods &
  SkillMethods &
  SkillSyncMethods &
  AgentTriggerDeliveryMethods &
  AgentQueuedTurnMethods &
  ScheduleMethods &
  AgentMethods &
  ConfigMethods &
  MCPAuthorityMethods &
  InsightsMethods;

/** Dependencies injected from the api layer into createMethods */
export interface CreateMethodsDeps {
  /** Matches a model name to a canonical key. From @librechat/api. */
  matchModelName?: (model: string, endpoint?: string) => string | undefined;
  /** Finds the first key in values whose key is a substring of model. From @librechat/api. */
  findMatchingPattern?: (
    model: string,
    values: Record<string, number | Record<string, number>>,
  ) => string | undefined;
  /** Removes all ACL permissions for a resource. From PermissionService. */
  removeAllPermissions?: (params: { resourceType: string; resourceId: unknown }) => Promise<void>;
  /** Returns a cache store for the given key. From getLogStores. */
  getCache?: RoleDeps['getCache'];
  /** Recognizes agent skill IDs supplied by an external, non-database registry. */
  isExternalSkillId?: AgentDeps['isExternalSkillId'];
}

/**
 * Creates all database methods for all collections
 * @param mongoose - Mongoose instance
 * @param deps - Optional dependencies injected from the api layer
 */
export function createMethods(
  mongoose: typeof import('mongoose'),
  deps: CreateMethodsDeps = {},
): AllMethods {
  // Tier 3: tx methods need matchModelName and findMatchingPattern
  const txDeps: TxDeps = {
    matchModelName: deps.matchModelName ?? (() => undefined),
    findMatchingPattern: deps.findMatchingPattern ?? (() => undefined),
  };
  const txMethods = createTxMethods(mongoose, txDeps);

  // Tier 3: transaction methods need tx's getMultiplier/getCacheMultiplier
  const transactionMethods = createTransactionMethods(mongoose, {
    getMultiplier: txMethods.getMultiplier,
    getCacheMultiplier: txMethods.getCacheMultiplier,
  });

  // Tier 3: spendTokens methods need transaction methods
  const spendTokensMethods = createSpendTokensMethods(mongoose, {
    createTransaction: transactionMethods.createTransaction,
    createStructuredTransaction: transactionMethods.createStructuredTransaction,
  });

  const messageMethods = createMessageMethods(mongoose);

  const agentQueuedTurnMethods = createAgentQueuedTurnMethods(mongoose);
  const agentTriggerDeliveryMethods = createAgentTriggerDeliveryMethods(mongoose, {
    purgeQueuedTurnsForUser: (user) =>
      agentQueuedTurnMethods.deleteAllAgentQueuedTurnsForUser({
        user: typeof user === 'string' ? new mongoose.Types.ObjectId(user) : user,
      }),
  });

  const conversationMethods = createConversationMethods(mongoose, {
    getMessages: messageMethods.getMessages,
    deleteMessages: messageMethods.deleteMessages,
    searchMessages: messageMethods.searchMessages,
    eraseAgentTriggerDeliveryConversationResults:
      agentTriggerDeliveryMethods.eraseAgentTriggerDeliveryConversationResults,
    prepareAgentTriggerConversationResultErasure:
      agentTriggerDeliveryMethods.prepareAgentTriggerConversationResultErasure,
    deleteAgentQueuedTurns: async (user, conversations) => {
      /** Queued-turn ownership is ObjectId-backed. Conversation methods also
       * support synthetic/non-ObjectId owners in embedded integrations and
       * tests; those owners cannot have queued-turn rows to retire. */
      if (!mongoose.isObjectIdOrHexString(user)) {
        return;
      }
      const owner = new mongoose.Types.ObjectId(user);
      const settledAt = new Date();
      const deliveryKeys = await agentQueuedTurnMethods.prepareAgentQueuedTurnConversationDeletion({
        user: owner,
        targets: conversations,
        settledAt,
      });
      await Promise.all(
        deliveryKeys.map(async (deliveryKey) => {
          const retirement = {
            deliveryKey,
            sourceId: 'agent-queued-turn',
            reason: 'queued_turn_conversation_deleted',
            settledAt,
            /** The source lane is fenced and admission has settled. Queued-turn
             * deliveries need not receive a later terminal handling receipt. */
            allowSucceeded: true,
          };
          let retired = await agentTriggerDeliveryMethods.retireAgentTriggerDelivery(retirement);
          if (!retired) {
            /** A delivery can exhaust immediately before owner deletion wins.
             * Convert that operator-requeueable dead row into the same terminal
             * retirement receipt before removing its source record. */
            retired = await agentTriggerDeliveryMethods.retireAgentTriggerDelivery({
              ...retirement,
              onlyIfDead: true,
            });
          }
          if (!retired) {
            /** Successful and dead delivery receipts have bounded retention.
             * A source in `published` proves the delivery existed, so a missing
             * receipt after both retirement attempts is terminal absence. */
            const fenced =
              await agentQueuedTurnMethods.beginAgentQueuedTurnMissingDeliveryRetirement({
                deliveryKey,
              });
            if (fenced) {
              const delivery =
                await agentTriggerDeliveryMethods.getAgentTriggerDelivery(deliveryKey);
              if (delivery == null) {
                retired = await agentQueuedTurnMethods.markAgentQueuedTurnMissingDeliveryRetired({
                  deliveryKey,
                });
              }
            }
          }
          if (retired) {
            await agentQueuedTurnMethods.markAgentQueuedTurnDeliveryRetired({ deliveryKey });
          }
        }),
      );
      await agentQueuedTurnMethods.deletePreparedAgentQueuedTurnConversations({
        user: owner,
        targets: conversations,
      });
    },
  });

  // ACL entry methods (used internally for removeAllPermissions)
  const aclEntryMethods = createAclEntryMethods(mongoose);

  const systemGrantMethods = createSystemGrantMethods(mongoose);

  // Internal removeAllPermissions: use deleteAclEntries from aclEntryMethods
  // instead of requiring it as an external dep from PermissionService
  const removeAllPermissions =
    deps.removeAllPermissions ??
    (async ({ resourceType, resourceId }: { resourceType: string; resourceId: unknown }) => {
      await aclEntryMethods.deleteAclEntries({ resourceType, resourceId });
    });

  // Role and user-group methods with optional cache injection; user-group methods
  // are created before prompt methods so prompt methods can resolve ACL principals.
  // The membership hook is late-bound: prompt methods do not exist yet here.
  const promptAccessInvalidator: { current?: () => Promise<void> } = {};
  const roleDeps: RoleDeps = { getCache: deps.getCache };
  const userGroupDeps: UserGroupDeps = {
    getCache: deps.getCache,
    onMemberGroupsInvalidated: () => promptAccessInvalidator.current?.(),
  };
  const roleMethods = createRoleMethods(mongoose, roleDeps);
  const userGroupMethods = createUserGroupMethods(mongoose, userGroupDeps);

  const promptDeps: PromptDeps = {
    removeAllPermissions,
    getSoleOwnedResourceIds: aclEntryMethods.getSoleOwnedResourceIds,
    getCache: deps.getCache,
    getUserPrincipals: userGroupMethods.getUserPrincipals,
    findAccessibleResources: aclEntryMethods.findAccessibleResources,
    findPublicResourceIds: aclEntryMethods.findPublicResourceIds,
  };
  const promptMethods = createPromptMethods(mongoose, promptDeps);
  promptAccessInvalidator.current = promptMethods.invalidatePromptGroupAccessContext;

  const skillDeps: SkillDeps = {
    removeAllPermissions,
    getSoleOwnedResourceIds: aclEntryMethods.getSoleOwnedResourceIds,
  };
  const skillMethods = createSkillMethods(mongoose, skillDeps);

  // Tier 1: action methods (created as variable for agent dependency)
  const actionMethods = createActionMethods(mongoose);

  // Tier 5: agent methods need removeAllPermissions + getActions
  const agentDeps: AgentDeps = {
    removeAllPermissions,
    getActions: actionMethods.getActions,
    getSoleOwnedResourceIds: aclEntryMethods.getSoleOwnedResourceIds,
    getUserPrincipals: userGroupMethods.getUserPrincipals,
    findAccessibleResources: aclEntryMethods.findAccessibleResources,
    isExternalSkillId: deps.isExternalSkillId,
  };
  const agentMethods = createAgentMethods(mongoose, agentDeps);
  return {
    ...createUserMethods(mongoose, { getCache: deps.getCache }),
    ...createSessionMethods(mongoose),
    ...createTokenMethods(mongoose),
    ...createRefreshTokenBridgeMethods(mongoose),
    ...createOpenIDRefreshFlightMethods(mongoose),
    ...roleMethods,
    ...createKeyMethods(mongoose),
    ...createFileMethods(mongoose),
    ...createMemoryMethods(mongoose),
    ...createToolFavoriteMethods(mongoose),
    ...createAgentCategoryMethods(mongoose),
    ...createAgentApiKeyMethods(mongoose),
    ...createMCPServerMethods(mongoose),
    ...createCodeEnvironmentMethods(mongoose),
    ...createAccessRoleMethods(mongoose),
    ...userGroupMethods,
    ...aclEntryMethods,
    ...systemGrantMethods,
    ...createAuditLogMethods(mongoose),
    ...createShareMethods(mongoose),
    ...createPluginAuthMethods(mongoose),
    /* Tier 1 */
    ...actionMethods,
    ...createAssistantMethods(mongoose),
    ...createBannerMethods(mongoose),
    ...createToolCallMethods(mongoose),
    ...createCategoriesMethods(mongoose),
    ...createPresetMethods(mongoose),
    /* Tier 2 */
    ...createConversationTagMethods(mongoose),
    ...createConversationImportMethods(mongoose),
    ...messageMethods,
    ...conversationMethods,
    ...createChatProjectMethods(mongoose),
    /* Tier 3 */
    ...txMethods,
    ...transactionMethods,
    ...spendTokensMethods,
    ...promptMethods,
    ...skillMethods,
    ...createSkillSyncMethods(mongoose),
    ...agentTriggerDeliveryMethods,
    ...agentQueuedTurnMethods,
    ...createScheduleMethods(mongoose),
    /* Tier 5 */
    ...agentMethods,
    /* Config */
    ...createConfigMethods(mongoose),
    /* MCP authority proofs */
    ...createMCPAuthorityMethods(mongoose),
    /* Insights */
    ...createInsightsMethods(mongoose),
  };
}

export type {
  UserMethods,
  SessionMethods,
  TokenMethods,
  RefreshTokenBridgeMethods,
  OpenIDRefreshFlightMethods,
  RoleMethods,
  KeyMethods,
  FileMethods,
  FileOwnerScope,
  MemoryMethods,
  ToolFavoriteMethods,
  AgentCategoryMethods,
  AgentApiKeyMethods,
  MCPServerMethods,
  CodeEnvironmentMethods,
  UserGroupMethods,
  AclEntryMethods,
  SystemGrantMethods,
  AuditLogMethods,
  ShareMethods,
  AccessRoleMethods,
  PluginAuthMethods,
  ActionMethods,
  AssistantMethods,
  BannerMethods,
  ToolCallMethods,
  CategoriesMethods,
  PresetMethods,
  ConversationTagMethods,
  ConversationImportMethods,
  MessageMethods,
  ParentSubagentTaskRecord,
  ParentSubagentThreadRecord,
  SubagentThreadViewMessageRecord,
  SubagentTaskResultClaim,
  BackgroundToolResultClaim,
  BackgroundToolResultRecord,
  ConversationTraceRefs,
  SampledTraceMessage,
  ConversationMethods,
  AgentEventActorReconciliationStorageMetrics,
  ChatProjectMethods,
  TxMethods,
  TransactionMethods,
  SpendTokensMethods,
  PromptMethods,
  SkillMethods,
  SkillDeps,
  CreateSkillInput,
  CreateSkillResult,
  UpdateSkillInput,
  UpsertSkillFileInput,
  ListSkillsByAccessParams,
  ListSkillsByAccessResult,
  UpdateSkillResult,
  ValidationIssue,
  DeleteSkillCleanupStep,
  DeleteSkillResult,
  SkillSyncStatusInput,
  SkillSyncCredentialSummary,
  UpsertSkillSyncCredentialInput,
  SkillSyncMethods,
  AgentTriggerDeliveryMethods,
  AgentQueuedTurnMethods,
  AgentTriggerProducerLeaseStatus,
  AgentEventActorReceiptMetric,
  AgentEventActorReceiptStorageMetrics,
  ScheduleMethods,
  AgentMethods,
  AgentGraphNode,
  AgentGraphAccess,
  AgentGraphAccessContext,
  ConfigMethods,
  MCPAuthorityMethods,
  MCPAuthorityMethodHooks,
  MCPAuthorityConfigSourceDocument,
  MCPAuthorityCredentialSourceDocument,
  InsightsMethods,
};

export { recordAgentEventActorReceiptMetric, setAgentEventActorReceiptMetricObserver };
