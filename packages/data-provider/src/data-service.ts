import type { AxiosResponse } from 'axios';
import type {
  TTracePage,
  TTracePageParams,
  TTraceAvailability,
  TTraceRecordParams,
  TTraceRecordDetail,
} from './types/traces';
import type { TInsightsAccessResponse, TInsightsParams, TInsightsResponse } from './types/insights';
import type { TFileConfig } from './file-config';
import type * as tl from './types/tools';
import type * as t from './types';
import * as permissions from './accessPermissions';
import * as endpoints from './api-endpoints';
import { uploadEventStream } from './upload';
import * as mcp from './types/mcpServers';
import * as qt from './types/queuedTurns';
import * as sch from './types/schedules';
import * as a from './types/assistants';
import * as m from './types/mutations';
import * as ag from './types/agents';
import * as q from './types/queries';
import * as sk from './types/skills';
import * as f from './types/files';
import * as config from './config';
import request from './request';
import * as s from './schemas';
import * as r from './roles';

export function getInsights(params: TInsightsParams = {}): Promise<TInsightsResponse> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      value.forEach((item) => query.append(key, String(item)));
    } else if (value !== undefined && value !== null && value !== '') {
      query.set(key, String(value));
    }
  }
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return request.get(`${endpoints.insights()}${suffix}`);
}

export function getInsightsAccess(): Promise<TInsightsAccessResponse> {
  return request.get(endpoints.insightsAccess());
}

export function getConversationTraceAvailability(
  conversationId: string,
): Promise<TTraceAvailability> {
  return request.get(endpoints.conversationTraceAvailability(conversationId));
}

export function getConversationTraceRecords(
  { conversationId, cursor }: TTracePageParams,
  signal?: AbortSignal,
): Promise<TTracePage> {
  return request.get(
    endpoints.conversationTraceRecords(conversationId, cursor),
    signal ? { signal } : undefined,
  );
}

export function getConversationTraceRecord(
  { conversationId, recordId, messageId, sourceId }: TTraceRecordParams,
  signal?: AbortSignal,
): Promise<TTraceRecordDetail> {
  return request.get(
    endpoints.conversationTraceRecord(conversationId, recordId, messageId, sourceId),
    signal ? { signal } : undefined,
  );
}

export function getLangfuseConnection(): Promise<t.TLangfuseConnectionStatus> {
  return request.get(endpoints.adminLangfuseConnection());
}

export function updateLangfuseConnection(
  payload: t.TUpdateLangfuseConnectionRequest,
): Promise<t.TLangfuseConnectionStatus> {
  return request.put(endpoints.adminLangfuseConnection(), payload);
}

export function testLangfuseConnection(
  payload: t.TLangfuseConnectionTestRequest,
): Promise<t.TLangfuseConnectionTestResponse> {
  return request.post(endpoints.adminLangfuseConnectionTest(), payload);
}

export function getLangfuseSessionLink(
  conversationId: string,
): Promise<t.TLangfuseSessionLinkResponse> {
  return request.get(endpoints.adminLangfuseSessionLink(conversationId));
}

export function revokeUserKey(name: string): Promise<unknown> {
  return request.delete(endpoints.revokeUserKey(name));
}

export function revokeAllUserKeys(): Promise<unknown> {
  return request.delete(endpoints.revokeAllUserKeys());
}

export function deleteUser(payload?: t.TDeleteUserRequest): Promise<unknown> {
  return request.deleteWithOptions(endpoints.deleteUser(), { data: payload });
}

export function getCodeEnvironments(): Promise<t.TCodeEnvironmentsResponse> {
  return request.get(endpoints.codeEnvironments());
}

export function getCodeEnvironmentStatus(id: string): Promise<t.TCodeEnvironmentStatusResponse> {
  return request.get(endpoints.codeEnvironmentStatus(id));
}

export function moveConversationCodeEnvironment({
  conversationId,
  from,
  to,
}: t.TCodeEnvironmentMoveRequest): Promise<t.TCodeEnvironmentMoveResponse> {
  return request.patch(endpoints.codeEnvironmentConversationDecision(conversationId), {
    from,
    to,
  });
}

export function pairCodeEnvironment(payload: {
  name: string;
  controlPlaneId: string;
}): Promise<t.TCodeEnvironmentPairingResponse> {
  return request.post(endpoints.codeEnvironmentPairings(), payload);
}

export function deleteCodeEnvironment(
  id: string,
): Promise<{ environment: t.TCodeEnvironmentSummary }> {
  return request.delete(endpoints.codeEnvironmentById(id));
}

export function updateCodeEnvironmentSettings({
  id,
  settings,
}: {
  id: string;
  settings: config.CodeEnvironmentUserSettings;
}): Promise<{ environment: t.TCodeEnvironmentSummary }> {
  return request.patch(endpoints.codeEnvironmentSettings(id), { settings });
}

export function getFavorites(): Promise<q.TUserFavorite[]> {
  return request.get(`${endpoints.apiBaseUrl()}/api/user/settings/favorites`);
}

export function updateFavorites(favorites: q.TUserFavorite[]): Promise<q.TUserFavorite[]> {
  return request.post(`${endpoints.apiBaseUrl()}/api/user/settings/favorites`, {
    favorites,
  });
}

/** Combined Pinned-section display order: favorite and pinned-chat entry keys interleaved. */
export function getPinnedOrder(): Promise<string[]> {
  return request.get(endpoints.pinnedOrder());
}

export function updatePinnedOrder(pinnedOrder: string[]): Promise<string[]> {
  return request.post(endpoints.pinnedOrder(), { pinnedOrder });
}

/** Tool favorites — starred marketplace items (builtins, tools, MCP servers, skills). */
export function getToolFavorites(): Promise<q.TToolFavorite[]> {
  return request.get(endpoints.toolFavorites());
}

export function addToolFavorite(favorite: q.TToolFavorite): Promise<q.TToolFavorite> {
  return request.put(endpoints.toolFavorite(favorite.itemType, favorite.itemId));
}

export function removeToolFavorite(favorite: q.TToolFavorite): Promise<{ ok: boolean }> {
  return request.delete(endpoints.toolFavorite(favorite.itemType, favorite.itemId));
}

/** Per-user skill active/inactive overrides. */
export function getSkillStates(): Promise<sk.TSkillStatesResponse> {
  return request.get(endpoints.skillStates());
}

export function updateSkillStates(
  skillStates: sk.TSkillStatesResponse,
): Promise<sk.TSkillStatesResponse> {
  return request.post(endpoints.skillStates(), { skillStates });
}

export function getSharedMessages(shareId: string): Promise<t.TSharedMessagesResponse> {
  return request.get(endpoints.shareMessages(shareId));
}

export function getSharedStartupConfig(shareId: string): Promise<config.TSharedLinkStartupConfig> {
  return request.get(endpoints.sharedStartupConfig(shareId));
}

export const listSharedLinks = async (
  params: q.SharedLinksListParams,
): Promise<q.SharedLinksResponse> => {
  const { pageSize, sortBy, sortDirection, search, cursor } = params;

  return request.get(endpoints.getSharedLinks(pageSize, sortBy, sortDirection, search, cursor));
};

export function getSharedLink(conversationId: string): Promise<t.TSharedLinkGetResponse> {
  return request.get(endpoints.getSharedLink(conversationId));
}

export function createSharedLink(
  conversationId: string,
  targetMessageId?: string,
  snapshotFiles?: boolean,
): Promise<t.TSharedLinkResponse> {
  return request.post(endpoints.createSharedLink(conversationId), {
    targetMessageId,
    snapshotFiles,
  });
}

export function updateSharedLink(
  shareId: string,
  targetMessageId?: string,
  snapshotFiles?: boolean,
): Promise<t.TSharedLinkResponse> {
  return request.patch(endpoints.updateSharedLink(shareId), {
    targetMessageId,
    snapshotFiles,
  });
}

export function deleteSharedLink(shareId: string): Promise<m.TDeleteSharedLinkResponse> {
  return request.delete(endpoints.shareMessages(shareId));
}

export function updateUserKey(payload: t.TUpdateUserKeyRequest) {
  const { value } = payload;
  if (!value) {
    throw new Error('value is required');
  }

  return request.put(endpoints.keys(), payload);
}

export function getAgentApiKeys(): Promise<t.TAgentApiKeyListResponse> {
  return request.get(endpoints.apiKeys());
}

export function createAgentApiKey(
  payload: t.TAgentApiKeyCreateRequest,
): Promise<t.TAgentApiKeyCreateResponse> {
  return request.post(endpoints.apiKeys(), payload);
}

export function deleteAgentApiKey(id: string): Promise<void> {
  return request.delete(endpoints.apiKeyById(id));
}

export function getPresets(): Promise<s.TPreset[]> {
  return request.get(endpoints.presets());
}

export function createPreset(payload: s.TPreset): Promise<s.TPreset> {
  return request.post(endpoints.presets(), payload);
}

export function updatePreset(payload: s.TPreset): Promise<s.TPreset> {
  return request.post(endpoints.presets(), payload);
}

export function deletePreset(arg: s.TPreset | undefined): Promise<m.PresetDeleteResponse> {
  return request.post(endpoints.deletePreset(), arg);
}

export function getSearchEnabled(): Promise<boolean> {
  return request.get(endpoints.searchEnabled());
}

export function getUser(): Promise<t.TUser> {
  return request.get(endpoints.user());
}

export function updateUserPreferences(
  preferences: t.TUpdateUserPreferencesRequest,
): Promise<t.TUpdateUserPreferencesResponse> {
  return request.patch(endpoints.userPreferences(), preferences);
}

export function getUserBalance(): Promise<t.TBalanceResponse> {
  return request.get(endpoints.balance());
}

export const updateTokenCount = (text: string) => {
  return request.post(endpoints.tokenizer(), { arg: text });
};

export const login = (payload: t.TLoginUser): Promise<t.TLoginResponse> => {
  return request.post(endpoints.login(), payload);
};

export const logout = (): Promise<m.TLogoutResponse> => {
  return request.post(endpoints.logout());
};

export const register = (payload: t.TRegisterUser) => {
  return request.post(endpoints.register(), payload);
};

export const userKeyQuery = (name: string): Promise<t.TCheckUserKeyResponse> =>
  request.get(endpoints.userKeyQuery(name));

export const getLoginGoogle = () => {
  return request.get(endpoints.loginGoogle());
};

export const requestPasswordReset = (
  payload: t.TRequestPasswordReset,
): Promise<t.TRequestPasswordResetResponse> => {
  return request.post(endpoints.requestPasswordReset(), payload);
};

export const resetPassword = (payload: t.TResetPassword) => {
  return request.post(endpoints.resetPassword(), payload);
};

export const verifyEmail = (payload: t.TVerifyEmail): Promise<t.VerifyEmailResponse> => {
  return request.post(endpoints.verifyEmail(), payload);
};

export const requestEmailChange = (
  payload: t.TRequestEmailChange,
): Promise<t.TEmailChangeResponse> => {
  return request.post(endpoints.requestEmailChange(), payload);
};

export const confirmEmailChange = (
  payload: t.TConfirmEmailChange,
): Promise<t.TEmailChangeResponse> => {
  return request.post(endpoints.confirmEmailChange(), payload);
};

export const resendVerificationEmail = (
  payload: t.TResendVerificationEmail,
): Promise<t.VerifyEmailResponse> => {
  return request.post(endpoints.resendVerificationEmail(), payload);
};

export const getAvailablePlugins = (): Promise<s.TPlugin[]> => {
  return request.get(endpoints.plugins());
};

export const updateUserPlugins = (payload: t.TUpdateUserPlugins) => {
  return request.post(endpoints.userPlugins(), payload);
};

export const reinitializeMCPServer = (serverName: string): Promise<mcp.MCPReinitializeResponse> => {
  return request.post(endpoints.mcpReinitialize(serverName));
};

export const bindMCPOAuth = (serverName: string): Promise<{ success: boolean }> => {
  return request.post(endpoints.mcpOAuthBind(serverName));
};

export const bindActionOAuth = (actionId: string): Promise<{ success: boolean }> => {
  return request.post(endpoints.actionOAuthBind(actionId));
};

export const getMCPConnectionStatus = (): Promise<q.MCPConnectionStatusResponse> => {
  return request.get(endpoints.mcpConnectionStatus());
};

export const getMCPServerConnectionStatus = (
  serverName: string,
): Promise<q.MCPServerConnectionStatusResponse> => {
  return request.get(endpoints.mcpServerConnectionStatus(serverName));
};

export const getMCPAuthValues = (serverName: string): Promise<q.MCPAuthValuesResponse> => {
  return request.get(endpoints.mcpAuthValues(serverName));
};

export function cancelMCPOAuth(serverName: string): Promise<m.CancelMCPOAuthResponse> {
  return request.post(endpoints.cancelMCPOAuth(serverName), {});
}

export function getMCPOAuthStatus(flowId: string): Promise<mcp.MCPOAuthStatusResponse> {
  return request.get(endpoints.mcpOAuthStatus(flowId));
}

/* Config */

export type StartupConfigOptions = {
  context?: config.StartupConfigContext;
};

export const getStartupConfig = (
  options?: StartupConfigOptions,
): Promise<
  config.TStartupConfig & {
    mcpCustomUserVars?: Record<string, { title: string; description: string }>;
  }
> => {
  return request.get(endpoints.config(options?.context));
};

export const getAIEndpoints = (): Promise<t.TEndpointsConfig> => {
  return request.get(endpoints.aiEndpoints());
};

export const getTokenConfig = (): Promise<t.TTokenConfigMap> => {
  return request.get(endpoints.tokenConfig());
};

export const getModels = async (): Promise<t.TModelsConfig> => {
  return request.get(endpoints.models());
};

/* Assistants */

export const createAssistant = ({
  version,
  ...data
}: a.AssistantCreateParams): Promise<a.Assistant> => {
  return request.post(endpoints.assistants({ version }), data);
};

export const getAssistantById = ({
  endpoint,
  assistant_id,
  version,
}: {
  endpoint: s.AssistantsEndpoint;
  assistant_id: string;
  version: number | string | number;
}): Promise<a.Assistant> => {
  return request.get(
    endpoints.assistants({
      path: assistant_id,
      endpoint,
      version,
    }),
  );
};

export const updateAssistant = ({
  assistant_id,
  data,
  version,
}: {
  assistant_id: string;
  data: a.AssistantUpdateParams;
  version: number | string;
}): Promise<a.Assistant> => {
  return request.patch(
    endpoints.assistants({
      path: assistant_id,
      version,
    }),
    data,
  );
};

export const deleteAssistant = ({
  assistant_id,
  model,
  endpoint,
  version,
}: m.DeleteAssistantBody & { version: number | string }): Promise<void> => {
  return request.delete(
    endpoints.assistants({
      path: assistant_id,
      options: { model, endpoint },
      version,
    }),
  );
};

export const listAssistants = (
  params: a.AssistantListParams,
  version: number | string,
): Promise<a.AssistantListResponse> => {
  return request.get(
    endpoints.assistants({
      version,
      options: params,
    }),
  );
};

export function getAssistantDocs({
  endpoint,
  version,
}: {
  endpoint: s.AssistantsEndpoint | string;
  version: number | string;
}): Promise<a.AssistantDocument[]> {
  if (!s.isAssistantsEndpoint(endpoint)) {
    return Promise.resolve([]);
  }
  return request.get(
    endpoints.assistants({
      path: 'documents',
      version,
      options: { endpoint },
      endpoint: endpoint as s.AssistantsEndpoint,
    }),
  );
}

/* Tools */

export const getAvailableTools = (
  _endpoint: s.AssistantsEndpoint | s.EModelEndpoint.agents,
  version?: number | string,
): Promise<s.TPlugin[]> => {
  let path = '';
  if (s.isAssistantsEndpoint(_endpoint)) {
    const endpoint = _endpoint as s.AssistantsEndpoint;
    path = endpoints.assistants({
      path: 'tools',
      endpoint: endpoint,
      version: version ?? config.defaultAssistantsVersion[endpoint],
    });
  } else {
    path = endpoints.agents({
      path: 'tools',
    });
  }

  return request.get(path);
};

/* MCP Tools - Decoupled from regular tools */

export const getMCPTools = (): Promise<q.MCPServersResponse> => {
  return request.get(endpoints.mcp.tools);
};

export const getVerifyAgentToolAuth = (
  params: q.VerifyToolAuthParams,
): Promise<q.VerifyToolAuthResponse> => {
  return request.get(
    endpoints.agents({
      path: `tools/${params.toolId}/auth`,
    }),
  );
};

export const callTool = <T extends m.ToolId>({
  toolId,
  toolParams,
}: {
  toolId: T;
  toolParams: m.ToolParams<T>;
}): Promise<m.ToolCallResponse> => {
  return request.post(
    endpoints.agents({
      path: `tools/${toolId}/call`,
    }),
    toolParams,
  );
};

export const getToolCalls = (params: q.GetToolCallParams): Promise<q.ToolCallResults> => {
  return request.get(
    endpoints.agents({
      path: 'tools/calls',
      options: params,
    }),
  );
};

/* Files */

export const getFiles = (params?: { limit?: number }): Promise<f.TFile[]> => {
  return request.get(
    endpoints.files(),
    params?.limit != null ? { params: { limit: params.limit } } : undefined,
  );
};

/**
 * Poll the lifecycle of an inline file preview. Returns the smallest
 * shape needed to drive the UI:
 *   - `status` always present (defaults to `'ready'` server-side for
 *     legacy records that pre-date the field).
 *   - `text` and `textFormat` only when `status === 'ready'` and text
 *     was extracted (preserves the HTML-or-null security contract).
 *   - `previewError` only when `status === 'failed'`.
 *
 * Called from `useFilePreview`; React Query's `refetchInterval`
 * polls while `status === 'pending'` and stops on terminal status.
 */
export const getFilePreview = (fileId: string): Promise<f.TFilePreview> => {
  return request.get(endpoints.filePreview(fileId));
};

/** Preview status for a snapshotted file served through a shared link. */
export const getSharedFilePreview = (shareId: string, fileId: string): Promise<f.TFilePreview> => {
  return request.get(endpoints.sharedFilePreview(shareId, fileId));
};

export const getAgentFiles = (agentId: string): Promise<f.TFile[]> => {
  return request.get(endpoints.agentFiles(agentId));
};

export const getFileConfig = (): Promise<TFileConfig> => {
  return request.get(`${endpoints.files()}/config`);
};

export const uploadImage = (
  data: FormData,
  signal?: AbortSignal | null,
  sseEnabled = false,
): Promise<f.TFileUpload> => {
  const requestConfig = signal ? { signal } : undefined;
  if (sseEnabled) {
    return uploadEventStream(endpoints.images(), data, signal);
  }
  return request.postMultiPart(endpoints.images(), data, requestConfig);
};

export const uploadFile = (
  data: FormData,
  signal?: AbortSignal | null,
  sseEnabled = false,
): Promise<f.TFileUpload> => {
  const requestConfig = signal ? { signal } : undefined;
  if (sseEnabled) {
    return uploadEventStream(endpoints.files(), data, signal);
  }
  return request.postMultiPart(endpoints.files(), data, requestConfig);
};

/**
 * Marks uploaded files as used (owner-scoped TTL touch) so the upload-window
 * TTL cannot reap attachments held in a client-side queue during a long run.
 * Best-effort: callers fire-and-forget — send-time marking is the backstop.
 */
export const markFilesUsage = (body: f.TFilesUsageBody): Promise<f.TFilesUsageResponse> => {
  return request.post(endpoints.fileUsage(), body);
};

/* actions */

export const updateAction = (data: m.UpdateActionVariables): Promise<m.UpdateActionResponse> => {
  const { assistant_id, version, ...body } = data;
  return request.post(
    endpoints.assistants({
      path: `actions/${assistant_id}`,
      version,
    }),
    body,
  );
};

export function getActions(): Promise<ag.Action[]> {
  return request.get(
    endpoints.agents({
      path: 'actions',
    }),
  );
}

export const deleteAction = async ({
  assistant_id,
  action_id,
  model,
  version,
  endpoint,
}: m.DeleteActionVariables & { version: number | string }): Promise<void> =>
  request.delete(
    endpoints.assistants({
      path: `actions/${assistant_id}/${action_id}/${model}`,
      version,
      endpoint,
    }),
  );

/**
 * Agents
 */

export const createAgent = ({ ...data }: ag.AgentCreateParams): Promise<ag.Agent> => {
  return request.post(endpoints.agents({}), data);
};

export const getAgentById = ({ agent_id }: { agent_id: string }): Promise<ag.Agent> => {
  return request.get(
    endpoints.agents({
      path: agent_id,
    }),
  );
};

export const getExpandedAgentById = ({ agent_id }: { agent_id: string }): Promise<ag.Agent> => {
  return request.get(
    endpoints.agents({
      path: `${agent_id}/expanded`,
    }),
  );
};

export const getAgentVersions = ({ agent_id }: { agent_id: string }): Promise<ag.Agent[]> => {
  return request.get(
    endpoints.agents({
      path: `${agent_id}/versions`,
    }),
  );
};

export const updateAgent = ({
  agent_id,
  data,
}: {
  agent_id: string;
  data: ag.AgentUpdateParams;
}): Promise<ag.Agent> => {
  return request.patch(
    endpoints.agents({
      path: agent_id,
    }),
    data,
  );
};

export const duplicateAgent = ({
  agent_id,
}: m.DuplicateAgentBody): Promise<{ agent: ag.Agent; actions: ag.Action[] }> => {
  return request.post(
    endpoints.agents({
      path: `${agent_id}/duplicate`,
    }),
  );
};

export const deleteAgent = ({ agent_id }: m.DeleteAgentBody): Promise<void> => {
  return request.delete(
    endpoints.agents({
      path: agent_id,
    }),
  );
};

export const listAgents = (params: ag.AgentListParams): Promise<ag.AgentListResponse> => {
  return request.get(
    endpoints.agents({
      options: params,
    }),
  );
};

export const revertAgentVersion = ({
  agent_id,
  version_index,
}: {
  agent_id: string;
  version_index: number;
}): Promise<ag.Agent> => request.post(endpoints.revertAgentVersion(agent_id), { version_index });

/* Marketplace */

/**
 * Get agent categories with counts for marketplace tabs
 */
export const getAgentCategories = (): Promise<t.TMarketplaceCategory[]> => {
  return request.get(endpoints.agents({ path: 'categories' }));
};

/**
 * Unified marketplace agents endpoint with query string controls
 */
export const getMarketplaceAgents = (params: ag.AgentListParams): Promise<ag.AgentListResponse> => {
  return request.get(
    endpoints.agents({
      options: params,
    }),
  );
};

/* Tools */

export const getAvailableAgentTools = (): Promise<s.TPlugin[]> => {
  return request.get(
    endpoints.agents({
      path: 'tools',
    }),
  );
};

/* Actions */

export const updateAgentAction = (
  data: m.UpdateAgentActionVariables,
): Promise<m.UpdateAgentActionResponse> => {
  const { agent_id, ...body } = data;
  return request.post(
    endpoints.agents({
      path: `actions/${agent_id}`,
    }),
    body,
  );
};

export const deleteAgentAction = async ({
  agent_id,
  action_id,
}: m.DeleteAgentActionVariables): Promise<void> =>
  request.delete(
    endpoints.agents({
      path: `actions/${agent_id}/${action_id}`,
    }),
  );

/**
 * MCP Servers
 */

/**
 *
 * Ensure and List loaded mcp server configs from the cache Enriched with effective permissions.
 */
export const getMCPServers = async (): Promise<mcp.MCPServersListResponse> => {
  return request.get(endpoints.mcp.servers);
};

/**
 * Get a single MCP server by ID
 */
export const getMCPServer = async (serverName: string): Promise<mcp.MCPServerDBObjectResponse> => {
  return request.get(endpoints.mcpServer(serverName));
};

/**
 * Create a new MCP server
 */
export const createMCPServer = async (
  data: mcp.MCPServerCreateParams,
): Promise<mcp.MCPServerDBObjectResponse> => {
  return request.post(endpoints.mcp.servers, data);
};

/**
 * Update an existing MCP server
 */
export const updateMCPServer = async (
  serverName: string,
  data: mcp.MCPServerUpdateParams,
): Promise<mcp.MCPServerDBObjectResponse> => {
  return request.patch(endpoints.mcpServer(serverName), data);
};

/**
 * Delete an MCP server
 */
export const deleteMCPServer = async (serverName: string): Promise<{ success: boolean }> => {
  return request.delete(endpoints.mcpServer(serverName));
};

/**
 * Imports a conversations file.
 *
 * @param data - The FormData containing the file to import.
 * @returns A Promise that resolves to the import start response.
 */
export const importConversationsFile = (data: FormData): Promise<t.TImportResponse> => {
  return request.postMultiPart(endpoints.importConversation(), data);
};

export const uploadAvatar = (data: FormData): Promise<f.AvatarUploadResponse> => {
  return request.postMultiPart(endpoints.avatar(), data);
};

export const uploadAssistantAvatar = (data: m.AssistantAvatarVariables): Promise<a.Assistant> => {
  return request.postMultiPart(
    endpoints.assistants({
      isAvatar: true,
      path: `${data.assistant_id}/avatar`,
      options: { model: data.model, endpoint: data.endpoint },
      version: data.version,
    }),
    data.formData,
  );
};

export const uploadAgentAvatar = (data: m.AgentAvatarVariables): Promise<ag.Agent> => {
  return request.postMultiPart(
    `${endpoints.images()}/agents/${data.agent_id}/avatar`,
    data.formData,
  );
};

export const getFileDownload = async (userId: string, file_id: string): Promise<AxiosResponse> => {
  return request.getResponse(`${endpoints.files()}/download/${userId}/${file_id}`, {
    responseType: 'blob',
    headers: {
      Accept: 'application/octet-stream',
    },
  });
};

export const getFileDownloadURL = async (
  userId: string,
  file_id: string,
): Promise<f.FileDownloadURLResponse> => {
  return request.get(`${endpoints.files()}/download-url/${userId}/${file_id}`);
};

/** Blob download for a snapshotted file served through a shared link. */
export const getSharedFileDownload = async (
  shareId: string,
  file_id: string,
): Promise<AxiosResponse> => {
  return request.getResponse(endpoints.sharedFileDownload(shareId, file_id), {
    responseType: 'blob',
    headers: {
      Accept: 'application/octet-stream',
    },
  });
};

export const getCodeOutputDownload = async (url: string): Promise<AxiosResponse> => {
  return request.getResponse(url, {
    responseType: 'blob',
    headers: {
      Accept: 'application/octet-stream',
    },
  });
};

export const deleteFiles = async (payload: {
  files: f.BatchFile[];
  agent_id?: string;
  assistant_id?: string;
  tool_resource?: tl.EToolResources;
}): Promise<f.DeleteFilesResponse> =>
  request.deleteWithOptions(endpoints.files(), {
    data: payload,
  });

/* Speech */

export const speechToText = (data: FormData): Promise<f.SpeechToTextResponse> => {
  return request.postMultiPart(endpoints.speechToText(), data);
};

export const textToSpeech = (data: FormData): Promise<ArrayBuffer> => {
  return request.postTTS(endpoints.textToSpeechManual(), data);
};

export const getVoices = (): Promise<f.VoiceResponse> => {
  return request.get(endpoints.textToSpeechVoices());
};

export const getCustomConfigSpeech = (): Promise<t.TCustomConfigSpeechResponse> => {
  return request.get(endpoints.getCustomConfigSpeech());
};

/* conversations */

export function duplicateConversation(
  payload: t.TDuplicateConvoRequest,
): Promise<t.TDuplicateConvoResponse> {
  return request.post(endpoints.duplicateConversation(), payload);
}

export function forkConversation(payload: t.TForkConvoRequest): Promise<t.TForkConvoResponse> {
  return request.post(endpoints.forkConversation(), payload);
}

export function forkSharedConversation(
  shareId: string,
  targetMessageIndex?: number,
  shareRevision?: string,
): Promise<t.TForkConvoResponse> {
  return request.post(endpoints.forkSharedMessages(shareId), {
    targetMessageIndex,
    shareRevision,
  });
}

export function deleteConversation(payload: t.TDeleteConversationRequest) {
  return request.deleteWithOptions(endpoints.deleteConversation(), {
    data: { arg: payload },
  });
}

export function clearAllConversations(): Promise<unknown> {
  return request.delete(endpoints.deleteAllConversation());
}

export const listConversations = (
  params?: q.ConversationListParams,
): Promise<q.ConversationListResponse> => {
  return request.get(endpoints.conversations(params ?? {}));
};

export function getConversations(cursor: string): Promise<t.TGetConversationsResponse> {
  return request.get(endpoints.conversations({ cursor }));
}

export function getConversationById(id: string): Promise<s.TConversation> {
  return request.get(endpoints.conversationById(id));
}

export function updateConversation(
  payload: t.TUpdateConversationRequest,
): Promise<t.TUpdateConversationResponse> {
  return request.post(endpoints.updateConversation(), { arg: payload });
}

export function archiveConversation(
  payload: t.TArchiveConversationRequest,
): Promise<t.TArchiveConversationResponse> {
  return request.post(endpoints.archiveConversation(), { arg: payload });
}

export function archiveAllConversations(): Promise<t.TArchiveAllConversationsResponse> {
  return request.post(endpoints.archiveAllConversations(), {});
}

export function listProjects(params?: q.ProjectListParams): Promise<q.ProjectListResponse> {
  return request.get(endpoints.projects(params ?? {}));
}

export function createProject(payload: t.TCreateChatProjectRequest): Promise<t.TChatProject> {
  return request.post(endpoints.projects(), payload);
}

export function getProjectById(projectId: string): Promise<t.TChatProject> {
  return request.get(endpoints.projectById(projectId));
}

export function updateProject(payload: t.TUpdateChatProjectRequest): Promise<t.TChatProject> {
  const { projectId, ...data } = payload;
  return request.patch(endpoints.projectById(projectId), data);
}

export function deleteProject(projectId: string): Promise<t.TDeleteChatProjectResponse> {
  return request.delete(endpoints.projectById(projectId));
}

export function assignConversationToProject(
  payload: t.TAssignConversationToProjectRequest,
): Promise<t.TAssignConversationToProjectResponse> {
  const { conversationId, projectId } = payload;
  return request.put(endpoints.projectConversation(conversationId), {
    projectId,
  });
}

export function pinConversation(
  payload: t.TPinConversationRequest,
): Promise<t.TPinConversationResponse> {
  return request.post(endpoints.pinConversation(), { arg: payload });
}

export function markConversationSeen(
  payload: t.TMarkConversationSeenRequest,
): Promise<t.TMarkConversationSeenResponse> {
  return request.post(endpoints.markConversationSeen(), { arg: payload });
}

export function markConversationUnread(
  payload: t.TMarkConversationUnreadRequest,
): Promise<t.TMarkConversationUnreadResponse> {
  return request.post(endpoints.markConversationUnread(), { arg: payload });
}

export function genTitle(payload: m.TGenTitleRequest): Promise<m.TGenTitleResponse> {
  return request.get(endpoints.genTitle(payload.conversationId));
}

export const listMessages = (params?: q.MessagesListParams): Promise<q.MessagesListResponse> => {
  return request.get(endpoints.messages(params ?? {}));
};

export function updateMessage(payload: t.TUpdateMessageRequest): Promise<unknown> {
  const { conversationId, messageId, text } = payload;
  if (!conversationId) {
    throw new Error('conversationId is required');
  }

  return request.put(endpoints.messages({ conversationId, messageId }), {
    text,
  });
}

export function updateMessageContent(payload: t.TUpdateMessageContent): Promise<unknown> {
  const { conversationId, messageId, index, text } = payload;
  if (!conversationId) {
    throw new Error('conversationId is required');
  }

  return request.put(endpoints.messages({ conversationId, messageId }), {
    text,
    index,
  });
}

export const editArtifact = async ({
  messageId,
  ...params
}: m.TEditArtifactRequest): Promise<m.TEditArtifactResponse> => {
  return request.post(endpoints.messagesArtifacts(messageId), params);
};

export const branchMessage = async (
  payload: m.TBranchMessageRequest,
): Promise<m.TBranchMessageResponse> => {
  return request.post(endpoints.messagesBranch(), payload);
};

export function getMessagesByConvoId(conversationId: string): Promise<s.TMessage[]> {
  if (
    conversationId === config.Constants.NEW_CONVO ||
    conversationId === config.Constants.PENDING_CONVO
  ) {
    return Promise.resolve([]);
  }
  return request.get(endpoints.messages({ conversationId }));
}

export function getMessageById(conversationId: string, messageId: string): Promise<s.TMessage[]> {
  return request.get(endpoints.messages({ conversationId, messageId }));
}

export function getParentSubagents(parentConversationId: string): Promise<t.ParentSubagentIndex> {
  return request.get(endpoints.parentSubagents(parentConversationId));
}

export function getSubagentThread(
  parentConversationId: string,
  threadId: string,
  taskId?: string,
  cursor?: string,
): Promise<t.SubagentThreadView> {
  return request.get(endpoints.subagentThread(parentConversationId, threadId, taskId, cursor));
}

export function controlSubagentTask(
  parentConversationId: string,
  threadId: string,
  body: t.SubagentControlRequest,
): Promise<t.SubagentControlResponse> {
  return request.post(endpoints.subagentControl(parentConversationId, threadId), body);
}

export function getPrompt(id: string): Promise<{ prompt: t.TPrompt }> {
  return request.get(endpoints.getPrompt(id));
}

export function getPrompts(filter: t.TPromptsWithFilterRequest): Promise<t.TPrompt[]> {
  return request.get(endpoints.getPromptsWithFilters(filter));
}

export function getAllPromptGroups(): Promise<q.AllPromptGroupsResponse> {
  return request.get(endpoints.getAllPromptGroups());
}

export function getPromptGroups(
  filter: t.TPromptGroupsWithFilterRequest,
): Promise<t.PromptGroupListResponse> {
  return request.get(endpoints.getPromptGroupsWithFilters(filter));
}

export function getPromptGroup(id: string): Promise<t.TPromptGroup> {
  return request.get(endpoints.getPromptGroup(id));
}

export function createPrompt(payload: t.TCreatePrompt): Promise<t.TCreatePromptResponse> {
  return request.post(endpoints.postPrompt(), payload);
}

export function addPromptToGroup(
  groupId: string,
  payload: t.TCreatePrompt,
): Promise<t.TCreatePromptResponse> {
  return request.post(endpoints.addPromptToGroup(groupId), payload);
}

export function updatePromptGroup(
  variables: t.TUpdatePromptGroupVariables,
): Promise<t.TUpdatePromptGroupResponse> {
  return request.patch(endpoints.updatePromptGroup(variables.id), variables.payload);
}

export function recordPromptGroupUsage(groupId: string): Promise<{ numberOfGenerations: number }> {
  return request.post(endpoints.recordPromptGroupUsage(groupId));
}

export function deletePrompt(payload: t.TDeletePromptVariables): Promise<t.TDeletePromptResponse> {
  return request.delete(endpoints.deletePrompt(payload));
}

export function makePromptProduction(id: string): Promise<t.TMakePromptProductionResponse> {
  return request.patch(endpoints.updatePromptTag(id));
}

export function updatePromptLabels(
  variables: t.TUpdatePromptLabelsRequest,
): Promise<t.TUpdatePromptLabelsResponse> {
  return request.patch(endpoints.updatePromptLabels(variables.id), variables.payload);
}

export function deletePromptGroup(id: string): Promise<t.TDeletePromptGroupResponse> {
  return request.delete(endpoints.deletePromptGroup(id));
}

export function getCategories(): Promise<t.TGetCategoriesResponse> {
  return request.get(endpoints.getCategories());
}

export function getRandomPrompts(
  variables: t.TGetRandomPromptsRequest,
): Promise<t.TGetRandomPromptsResponse> {
  return request.get(endpoints.getRandomPrompts(variables.limit, variables.skip));
}

/* Skills */

export function listSkills(params?: sk.TSkillListRequest): Promise<sk.TSkillListResponse> {
  return request.get(endpoints.listSkillsWithFilters(params ?? {}));
}

export function getSchedules(): Promise<sch.TSchedulesResponse> {
  return request.get(endpoints.schedules());
}

export function enqueueAgentQueuedTurn(
  payload: qt.TEnqueueAgentQueuedTurnRequest,
): Promise<qt.TEnqueueAgentQueuedTurnResponse> {
  return request.post(endpoints.agentQueuedTurns(), payload);
}

export function listAgentQueuedTurns(
  conversationId: string,
  clientRequestIds?: string[],
): Promise<qt.TListAgentQueuedTurnsResponse> {
  return request.get(endpoints.agentQueuedTurnsByConversation(conversationId, clientRequestIds));
}

export function cancelAgentQueuedTurn(
  queuedTurnId: string,
): Promise<qt.TCancelAgentQueuedTurnResponse> {
  return request.delete(endpoints.agentQueuedTurn(queuedTurnId));
}

export function getSchedule(id: string): Promise<sch.TSchedule> {
  return request.get(endpoints.schedule(id));
}

export function createSchedule(payload: sch.TCreateSchedule): Promise<sch.TSchedule> {
  return request.post(endpoints.schedules(), payload);
}

export function updateSchedule(id: string, payload: sch.TUpdateSchedule): Promise<sch.TSchedule> {
  return request.patch(endpoints.schedule(id), payload);
}

export function deleteSchedule(id: string): Promise<{ id: string }> {
  return request.delete(endpoints.schedule(id));
}

export function runScheduleNow(id: string): Promise<sch.TScheduleRunNowResponse> {
  return request.post(endpoints.runSchedule(id), {});
}

export function getSkill(id: string): Promise<sk.TSkill> {
  return request.get(endpoints.getSkill(id));
}

export function createSkill(payload: sk.TCreateSkill): Promise<sk.TSkill> {
  return request.post(endpoints.skills(), payload);
}

export function updateSkill(variables: sk.TUpdateSkillVariables): Promise<sk.TUpdateSkillResponse> {
  return request.patch(endpoints.getSkill(variables.id), {
    expectedVersion: variables.expectedVersion,
    ...variables.payload,
  });
}

export function deleteSkill(id: string): Promise<sk.TDeleteSkillResponse> {
  return request.delete(endpoints.getSkill(id));
}

export function listSkillFiles(skillId: string): Promise<sk.TListSkillFilesResponse> {
  return request.get(endpoints.skillFiles(skillId));
}

export function uploadSkillFile(skillId: string, formData: FormData): Promise<sk.TSkillFile> {
  return request.postMultiPart(endpoints.skillFiles(skillId), formData);
}

/**
 * Import a skill from a .md, .zip, or .skill file. The backend extracts the
 * archive, creates the skill from SKILL.md, and persists all additional files.
 * Single HTTP request — no client-side zip processing needed.
 */
export function importSkill(formData: FormData): Promise<sk.TSkill> {
  return request.postMultiPart(endpoints.importSkill(), formData);
}

export function getSkillFileContent(
  skillId: string,
  relativePath: string,
): Promise<sk.TSkillFileContentResponse> {
  return request.get(endpoints.skillFile(skillId, relativePath));
}

export function deleteSkillFile(
  skillId: string,
  relativePath: string,
): Promise<sk.TDeleteSkillFileResponse> {
  return request.delete(endpoints.skillFile(skillId, relativePath));
}

/* -------------------------------------------------------------------------- */
/* Skill Tree (nodes) — phase 2 backend                                       */
/* -------------------------------------------------------------------------- */
/* These were introduced by the original UI PR and are shipped as stubs in    */
/* phase 1 so the tree UI compiles. Each resolves with empty/no-op data until */
/* the backend persists a folder hierarchy. The call surface matches what the */
/* tree hooks expect so wiring real endpoints later is a one-line swap.       */

export const getSkillTree = (_skillId: string): Promise<t.TSkillTreeResponse> => {
  return Promise.resolve({ nodes: [] });
};

export const createSkillNode = (
  skillId: string,
  data: FormData | t.TCreateSkillNodeRequest,
): Promise<t.TSkillNode> => {
  const name = data instanceof FormData ? (data.get('name') as string) || 'untitled' : data.name;
  const type = data instanceof FormData ? 'file' : data.type;
  const now = new Date().toISOString();
  return Promise.resolve({
    _id: `pending-${now}`,
    skillId,
    parentId: null,
    type,
    name,
    order: 0,
    author: '',
    createdAt: now,
    updatedAt: now,
  });
};

export const updateSkillNode = (variables: {
  skillId: string;
  nodeId: string;
  data: t.TUpdateSkillNodeRequest;
}): Promise<t.TSkillNode> => {
  const now = new Date().toISOString();
  return Promise.resolve({
    _id: variables.nodeId,
    skillId: variables.skillId,
    parentId: variables.data.parentId ?? null,
    type: 'file',
    name: variables.data.name ?? '',
    order: variables.data.order ?? 0,
    author: '',
    createdAt: now,
    updatedAt: now,
  });
};

export const deleteSkillNode = (_variables: { skillId: string; nodeId: string }): Promise<void> => {
  return Promise.resolve();
};

export const getSkillNodeContent = (_variables: {
  skillId: string;
  nodeId: string;
}): Promise<{ content: string; mimeType: string }> => {
  return Promise.resolve({ content: '', mimeType: 'text/plain' });
};

export const updateSkillNodeContent = (variables: {
  skillId: string;
  nodeId: string;
  content: string;
}): Promise<t.TSkillNode> => {
  const now = new Date().toISOString();
  return Promise.resolve({
    _id: variables.nodeId,
    skillId: variables.skillId,
    parentId: null,
    type: 'file',
    name: '',
    order: 0,
    author: '',
    createdAt: now,
    updatedAt: now,
  });
};

export function getGitHubSkillSyncStatus(): Promise<sk.TGitHubSkillSyncStatusResponse> {
  return request.get(endpoints.adminSkillsSyncStatus());
}

export function runGitHubSkillSync(): Promise<sk.TGitHubSkillSyncManualRunResponse> {
  return request.post(endpoints.adminSkillsSyncRun());
}

export function setGitHubSkillSyncCredential(variables: {
  credentialKey: string;
  token: string;
}): Promise<sk.TGitHubSkillSyncCredentialSummary> {
  return request.put(endpoints.adminSkillsSyncCredential(variables.credentialKey), {
    token: variables.token,
  } satisfies sk.TGitHubSkillSyncCredentialUpdateRequest);
}

export function deleteGitHubSkillSyncCredential(
  credentialKey: string,
): Promise<{ credentialKey: string; deleted: boolean }> {
  return request.delete(endpoints.adminSkillsSyncCredential(credentialKey));
}

/* Roles */
export function listRoles(): Promise<q.ListRolesResponse> {
  return request.get(`${endpoints.adminRoles()}?limit=200`);
}

export function getRole(roleName: string): Promise<r.TRole> {
  return request.get(endpoints.getRole(roleName));
}

export function updatePromptPermissions(
  variables: m.UpdatePromptPermVars,
): Promise<m.UpdatePermResponse> {
  return request.put(endpoints.updatePromptPermissions(variables.roleName), variables.updates);
}

export function updateAgentPermissions(
  variables: m.UpdateAgentPermVars,
): Promise<m.UpdatePermResponse> {
  return request.put(endpoints.updateAgentPermissions(variables.roleName), variables.updates);
}

export function updateMemoryPermissions(
  variables: m.UpdateMemoryPermVars,
): Promise<m.UpdatePermResponse> {
  return request.put(endpoints.updateMemoryPermissions(variables.roleName), variables.updates);
}

export function updatePeoplePickerPermissions(
  variables: m.UpdatePeoplePickerPermVars,
): Promise<m.UpdatePermResponse> {
  return request.put(
    endpoints.updatePeoplePickerPermissions(variables.roleName),
    variables.updates,
  );
}

export function updateMCPServersPermissions(
  variables: m.UpdateMCPServersPermVars,
): Promise<m.UpdatePermResponse> {
  return request.put(endpoints.updateMCPServersPermissions(variables.roleName), variables.updates);
}

export function updateRemoteAgentsPermissions(
  variables: m.UpdateRemoteAgentsPermVars,
): Promise<m.UpdatePermResponse> {
  return request.put(
    endpoints.updateRemoteAgentsPermissions(variables.roleName),
    variables.updates,
  );
}

export function updateMarketplacePermissions(
  variables: m.UpdateMarketplacePermVars,
): Promise<m.UpdatePermResponse> {
  return request.put(endpoints.updateMarketplacePermissions(variables.roleName), variables.updates);
}

export function updateSkillPermissions(
  variables: m.UpdateSkillPermVars,
): Promise<m.UpdatePermResponse> {
  return request.put(endpoints.updateSkillPermissions(variables.roleName), variables.updates);
}

/* Tags */
export function getConversationTags(): Promise<t.TConversationTagsResponse> {
  return request.get(endpoints.conversationTags());
}

export function createConversationTag(
  payload: t.TConversationTagRequest,
): Promise<t.TConversationTagResponse> {
  return request.post(endpoints.conversationTags(), payload);
}

export function updateConversationTag(
  tag: string,
  payload: t.TConversationTagRequest,
): Promise<t.TConversationTagResponse> {
  return request.put(endpoints.conversationTags(tag), payload);
}
export function deleteConversationTag(tag: string): Promise<t.TConversationTagResponse> {
  return request.delete(endpoints.conversationTags(tag));
}

export function addTagToConversation(
  conversationId: string,
  payload: t.TTagConversationRequest,
): Promise<t.TTagConversationResponse> {
  return request.put(endpoints.addTagToConversation(conversationId), payload);
}
export function rebuildConversationTags(): Promise<t.TConversationTagsResponse> {
  return request.post(endpoints.conversationTags('rebuild'));
}

export function healthCheck(): Promise<string> {
  return request.get(endpoints.health());
}

export function getUserTerms(): Promise<t.TUserTermsResponse> {
  return request.get(endpoints.userTerms());
}

export function acceptTerms(): Promise<t.TAcceptTermsResponse> {
  return request.post(endpoints.acceptUserTerms());
}

export function getBanner(): Promise<t.TBannerResponse> {
  return request.get(endpoints.banner());
}

export function updateFeedback(
  conversationId: string,
  messageId: string,
  payload: t.TUpdateFeedbackRequest,
): Promise<t.TUpdateFeedbackResponse> {
  return request.put(endpoints.feedback(conversationId, messageId), payload);
}

// 2FA
export function enableTwoFactor(payload?: t.TEnable2FARequest): Promise<t.TEnable2FAResponse> {
  return request.post(endpoints.enableTwoFactor(), payload);
}

export function verifyTwoFactor(payload: t.TVerify2FARequest): Promise<t.TVerify2FAResponse> {
  return request.post(endpoints.verifyTwoFactor(), payload);
}

export function confirmTwoFactor(payload: t.TVerify2FARequest): Promise<t.TVerify2FAResponse> {
  return request.post(endpoints.confirmTwoFactor(), payload);
}

export function disableTwoFactor(payload?: t.TDisable2FARequest): Promise<t.TDisable2FAResponse> {
  return request.post(endpoints.disableTwoFactor(), payload);
}

export function regenerateBackupCodes(
  payload?: t.TRegenerateBackupCodesRequest,
): Promise<t.TRegenerateBackupCodesResponse> {
  return request.post(endpoints.regenerateBackupCodes(), payload);
}

export function verifyTwoFactorTemp(
  payload: t.TVerify2FATempRequest,
): Promise<t.TVerify2FATempResponse> {
  return request.post(endpoints.verifyTwoFactorTemp(), payload);
}

// Passkeys (WebAuthn)
export function getPasskeys(): Promise<t.TPasskeysResponse> {
  return request.get(endpoints.passkeys());
}

export function getPasskeyRegistrationOptions(
  payload: t.TPasskeyRegistrationOptionsRequest,
): Promise<t.TPasskeyCreationOptions> {
  return request.post(endpoints.passkeyRegistrationOptions(), payload);
}

export function verifyPasskeyRegistration(
  payload: t.TVerifyPasskeyRegistrationRequest,
): Promise<t.TPasskeyResponse> {
  return request.post(endpoints.passkeyRegistrationVerify(), payload);
}

export function getPasskeyLoginOptions(): Promise<t.TPasskeyAuthenticationOptionsResponse> {
  return request.post(endpoints.passkeyLoginOptions(), {});
}

export function verifyPasskeyLogin(
  payload: t.TVerifyPasskeyLoginRequest,
): Promise<t.TLoginResponse> {
  return request.post(endpoints.passkeyLoginVerify(), payload);
}

export function renamePasskey({
  passkeyId,
  name,
}: t.TRenamePasskeyRequest): Promise<t.TPasskeyResponse> {
  return request.patch(endpoints.passkey(passkeyId), { name });
}

export function deletePasskey({
  passkeyId,
  password,
}: t.TDeletePasskeyRequest): Promise<{ message: string }> {
  return request.deleteWithOptions(endpoints.passkey(passkeyId), { data: { password } });
}

/* Memories */
export const getMemories = (): Promise<q.MemoriesResponse> => {
  return request.get(endpoints.memories());
};

export const deleteMemory = (key: string, agentId?: string): Promise<q.DeleteMemoryResponse> => {
  return request.delete(endpoints.memory(key, agentId));
};

export const deleteMemoryById = (id: string, agentId?: string): Promise<q.DeleteMemoryResponse> => {
  return request.delete(endpoints.memoryById(id, agentId));
};

export const updateMemory = (
  key: string,
  value: string,
  originalKey?: string,
  agentId?: string,
): Promise<q.UpdateMemoryResponse> => {
  return request.patch(endpoints.memory(originalKey || key, agentId), {
    key,
    value,
  });
};

export const updateMemoryById = (
  id: string,
  value: string,
  key?: string,
  agentId?: string,
): Promise<q.UpdateMemoryResponse> => {
  return request.patch(endpoints.memoryById(id, agentId), {
    value,
    ...(key ? { key } : {}),
  });
};

export const updateMemoryPreferences = (preferences: {
  memories: boolean;
}): Promise<{ updated: boolean; preferences: { memories: boolean } }> => {
  return request.patch(endpoints.memoryPreferences(), preferences);
};

export const createMemory = (data: {
  key: string;
  value: string;
  agentId?: string;
}): Promise<{ created: boolean; memory: q.TUserMemory }> => {
  return request.post(endpoints.memories(), data);
};

export function searchPrincipals(
  params: q.PrincipalSearchParams,
): Promise<q.PrincipalSearchResponse> {
  return request.get(endpoints.searchPrincipals(params));
}

export function getAccessRoles(
  resourceType: permissions.ResourceType,
): Promise<q.AccessRolesResponse> {
  return request.get(endpoints.getAccessRoles(resourceType));
}

export function getResourcePermissions(
  resourceType: permissions.ResourceType,
  resourceId: string,
): Promise<permissions.TGetResourcePermissionsResponse> {
  return request.get(endpoints.getResourcePermissions(resourceType, resourceId));
}

export function updateResourcePermissions(
  resourceType: permissions.ResourceType,
  resourceId: string,
  data: permissions.TUpdateResourcePermissionsRequest,
): Promise<permissions.TUpdateResourcePermissionsResponse> {
  return request.put(endpoints.updateResourcePermissions(resourceType, resourceId), data);
}

export function getEffectivePermissions(
  resourceType: permissions.ResourceType,
  resourceId: string,
): Promise<permissions.TEffectivePermissionsResponse> {
  return request.get(endpoints.getEffectivePermissions(resourceType, resourceId));
}

export function getAllEffectivePermissions(
  resourceType: permissions.ResourceType,
): Promise<permissions.TAllEffectivePermissionsResponse> {
  return request.get(endpoints.getAllEffectivePermissions(resourceType));
}

// SharePoint Graph API Token
export function getGraphApiToken(params: q.GraphTokenParams): Promise<q.GraphTokenResponse> {
  return request.get(endpoints.graphToken(params.scopes));
}

export function getDomainServerBaseUrl(): string {
  return `${endpoints.apiBaseUrl()}/api`;
}

/* Active Jobs */
export interface ActiveJobsResponse {
  activeJobIds: string[];
}

export const getActiveJobs = (): Promise<ActiveJobsResponse> => {
  return request.get(endpoints.activeJobs());
};
