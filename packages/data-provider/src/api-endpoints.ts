import type { StartupConfigContext } from './config';
import type { AssistantsEndpoint } from './schemas';
import { ResourceType } from './accessPermissions';
import * as q from './types/queries';

let BASE_URL = '';
if (
  typeof process === 'undefined' ||
  (process as typeof process & { browser?: boolean }).browser === true
) {
  // process is only available in node context, or process.browser is true in client-side code
  // This is to ensure that the BASE_URL is set correctly based on the <base>
  // element in the HTML document, if it exists.
  const baseEl = document.querySelector('base');
  BASE_URL = baseEl?.getAttribute('href') || '/';
}

if (BASE_URL && BASE_URL.endsWith('/')) {
  BASE_URL = BASE_URL.slice(0, -1);
}

export const apiBaseUrl = () => BASE_URL;

// Testing this buildQuery function
const buildQuery = (params: Record<string, unknown>): string => {
  const query = Object.entries(params)
    .filter(([, value]) => {
      if (Array.isArray(value)) {
        return value.length > 0;
      }
      return value !== undefined && value !== null && value !== '';
    })
    .map(([key, value]) => {
      if (Array.isArray(value)) {
        return value.map((v) => `${key}=${encodeURIComponent(v)}`).join('&');
      }
      return `${key}=${encodeURIComponent(String(value))}`;
    })
    .join('&');
  return query ? `?${query}` : '';
};

export const health = () => `${BASE_URL}/health`;
export const user = () => `${BASE_URL}/api/user`;
export const userPreferences = () => `${user()}/preferences`;

export const balance = () => `${BASE_URL}/api/balance`;

export const userPlugins = () => `${BASE_URL}/api/user/plugins`;

export const deleteUser = () => `${BASE_URL}/api/user/delete`;
export const codeEnvironments = () => `${BASE_URL}/api/code-environments`;
export const codeEnvironmentPairings = () => `${codeEnvironments()}/pairings`;
export const codeEnvironmentById = (id: string) =>
  `${codeEnvironments()}/${encodeURIComponent(id)}`;
export const codeEnvironmentSettings = (id: string) => `${codeEnvironmentById(id)}/settings`;
export const codeEnvironmentStatus = (id: string) => `${codeEnvironmentById(id)}/status`;
export const codeEnvironmentConversationDecision = (conversationId: string) =>
  `${codeEnvironments()}/conversations/${encodeURIComponent(conversationId)}/decision`;

const messagesRoot = `${BASE_URL}/api/messages`;

export const messages = (params: q.MessagesListParams) => {
  const { conversationId, messageId, ...rest } = params;

  if (conversationId && messageId) {
    return `${messagesRoot}/${conversationId}/${messageId}`;
  }

  if (conversationId) {
    return `${messagesRoot}/${conversationId}`;
  }

  return `${messagesRoot}${buildQuery(rest)}`;
};

export const messagesArtifacts = (messageId: string) => `${messagesRoot}/artifact/${messageId}`;

export const messagesBranch = () => `${messagesRoot}/branch`;

const shareRoot = `${BASE_URL}/api/share`;
export const shareMessages = (shareId: string) => `${shareRoot}/${shareId}`;
export const forkSharedMessages = (shareId: string) => `${shareRoot}/${shareId}/fork`;
export const sharedStartupConfig = (shareId: string) => `${shareMessages(shareId)}/config`;
export const getSharedLink = (conversationId: string) => `${shareRoot}/link/${conversationId}`;
export const getSharedLinks = (
  pageSize: number,
  sortBy: 'title' | 'createdAt',
  sortDirection: 'asc' | 'desc',
  search?: string,
  cursor?: string,
) => `${shareRoot}${buildQuery({ pageSize, sortBy, sortDirection, search, cursor })}`;
export const createSharedLink = (conversationId: string) => `${shareRoot}/${conversationId}`;
export const updateSharedLink = (shareId: string) => `${shareRoot}/${shareId}`;
/** Share-scoped file routes: serve snapshotted files via shared-link permission. */
export const sharedFile = (shareId: string, fileId: string) =>
  `${shareRoot}/${shareId}/files/${encodeURIComponent(fileId)}`;
export const sharedFileDownload = (shareId: string, fileId: string) =>
  `${sharedFile(shareId, fileId)}/download`;
export const sharedFilePreview = (shareId: string, fileId: string) =>
  `${sharedFile(shareId, fileId)}/preview`;

const keysEndpoint = `${BASE_URL}/api/keys`;

export const keys = () => keysEndpoint;

export const userKeyQuery = (name: string) => `${keysEndpoint}?name=${name}`;

export const revokeUserKey = (name: string) => `${keysEndpoint}/${name}`;

export const revokeAllUserKeys = () => `${keysEndpoint}?all=true`;

const apiKeysEndpoint = `${BASE_URL}/api/api-keys`;

export const apiKeys = () => apiKeysEndpoint;

export const apiKeyById = (id: string) => `${apiKeysEndpoint}/${id}`;

export const conversationsRoot = `${BASE_URL}/api/convos`;

export const conversations = (params: q.ConversationListParams) => {
  return `${conversationsRoot}${buildQuery(params)}`;
};

export const conversationById = (id: string) => `${conversationsRoot}/${id}`;

export const parentSubagents = (parentConversationId: string) =>
  `${conversationsRoot}/${encodeURIComponent(parentConversationId)}/subagents`;

export const subagentThread = (
  parentConversationId: string,
  threadId: string,
  taskId?: string,
  cursor?: string,
) => {
  const endpoint = `${conversationsRoot}/${encodeURIComponent(parentConversationId)}/subagents/${encodeURIComponent(threadId)}`;
  if (taskId != null) return `${endpoint}?taskId=${encodeURIComponent(taskId)}`;
  return cursor == null ? endpoint : `${endpoint}?cursor=${encodeURIComponent(cursor)}`;
};

export const subagentControl = (parentConversationId: string, threadId: string) =>
  `${conversationsRoot}/${encodeURIComponent(parentConversationId)}/subagents/${encodeURIComponent(threadId)}/control`;

export const backgroundTasks = (conversationId: string) =>
  `${conversationsRoot}/${encodeURIComponent(conversationId)}/background-tasks`;

export const backgroundTasksCancel = (conversationId: string) =>
  `${backgroundTasks(conversationId)}/cancel`;

export const genTitle = (conversationId: string) =>
  `${conversationsRoot}/gen_title/${encodeURIComponent(conversationId)}`;

export const updateConversation = () => `${conversationsRoot}/update`;

export const archiveConversation = () => `${conversationsRoot}/archive`;
export const archiveAllConversations = () => `${conversationsRoot}/archive/all`;
export const pinConversation = () => `${conversationsRoot}/pin`;

export const deleteConversation = () => `${conversationsRoot}`;

export const deleteAllConversation = () => `${conversationsRoot}/all`;

export const importConversation = () => `${conversationsRoot}/import`;

export const forkConversation = () => `${conversationsRoot}/fork`;

export const duplicateConversation = () => `${conversationsRoot}/duplicate`;

export const projectsRoot = `${BASE_URL}/api/projects`;

export const projects = (params: q.ProjectListParams = {}) => {
  return `${projectsRoot}${buildQuery(params)}`;
};

export const projectById = (id: string) => `${projectsRoot}/${encodeURIComponent(id)}`;

export const projectConversation = (conversationId: string) =>
  `${projectsRoot}/conversations/${encodeURIComponent(conversationId)}`;

export const search = (q: string, cursor?: string | null) =>
  `${BASE_URL}/api/search?q=${q}${cursor ? `&cursor=${cursor}` : ''}`;

export const searchEnabled = () => `${BASE_URL}/api/search/enable`;

export const presets = () => `${BASE_URL}/api/presets`;

export const deletePreset = () => `${BASE_URL}/api/presets/delete`;

export const aiEndpoints = () => `${BASE_URL}/api/endpoints`;

export const tokenConfig = () => `${BASE_URL}/api/endpoints/token-config`;

export const models = () => `${BASE_URL}/api/models`;

export const tokenizer = () => `${BASE_URL}/api/tokenizer`;

export const login = () => `${BASE_URL}/api/auth/login`;

export const logout = () => `${BASE_URL}/api/auth/logout`;

export const register = () => `${BASE_URL}/api/auth/register`;

export const loginFacebook = () => `${BASE_URL}/api/auth/facebook`;

export const loginGoogle = () => `${BASE_URL}/api/auth/google`;

export const refreshToken = (retry?: boolean) =>
  `${BASE_URL}/api/auth/refresh${retry === true ? '?retry=true' : ''}`;

export const requestPasswordReset = () => `${BASE_URL}/api/auth/requestPasswordReset`;

export const resetPassword = () => `${BASE_URL}/api/auth/resetPassword`;

export const verifyEmail = () => `${BASE_URL}/api/user/verify`;

// Auth page URLs (for client-side navigation and redirects)
export const loginPage = () => `${BASE_URL}/login`;
export const registerPage = () => `${BASE_URL}/register`;

const REDIRECT_PARAM = 'redirect_to';
const LOGIN_PATH_RE = /(?:^|\/)login(?:\/|$)/;

/**
 * Builds a `/login?redirect_to=...` URL from the given or current location.
 * Returns plain `/login` (no param) when already on a login route to prevent recursive nesting.
 */
export function buildLoginRedirectUrl(pathname?: string, search?: string, hash?: string): string {
  const p = pathname ?? window.location.pathname;
  if (LOGIN_PATH_RE.test(p)) {
    return '/login';
  }
  const s = search ?? window.location.search;
  const h = hash ?? window.location.hash;

  const stripped =
    BASE_URL && (p === BASE_URL || p.startsWith(BASE_URL + '/'))
      ? p.slice(BASE_URL.length) || '/'
      : p;
  const currentPath = `${stripped}${s}${h}`;
  if (!currentPath || currentPath === '/') {
    return '/login';
  }
  return `/login?${REDIRECT_PARAM}=${encodeURIComponent(currentPath)}`;
}

export const resendVerificationEmail = () => `${BASE_URL}/api/user/verify/resend`;

export const plugins = () => `${BASE_URL}/api/plugins`;

export const mcpReinitialize = (serverName: string) =>
  `${BASE_URL}/api/mcp/${serverName}/reinitialize`;
export const mcpConnectionStatus = () => `${BASE_URL}/api/mcp/connection/status`;
export const mcpServerConnectionStatus = (serverName: string) =>
  `${BASE_URL}/api/mcp/connection/status/${serverName}`;
export const mcpAuthValues = (serverName: string) => {
  return `${BASE_URL}/api/mcp/${serverName}/auth-values`;
};

export const cancelMCPOAuth = (serverName: string) => {
  return `${BASE_URL}/api/mcp/oauth/cancel/${serverName}`;
};

export const mcpOAuthStatus = (flowId: string) =>
  `${BASE_URL}/api/mcp/oauth/status/${encodeURIComponent(flowId)}`;

export const mcpOAuthBind = (serverName: string) => `${BASE_URL}/api/mcp/${serverName}/oauth/bind`;

export const actionOAuthBind = (actionId: string) =>
  `${BASE_URL}/api/actions/${actionId}/oauth/bind`;

export const config = (context?: StartupConfigContext) =>
  `${BASE_URL}/api/config${buildQuery({ context })}`;

export const prompts = () => `${BASE_URL}/api/prompts`;

export const addPromptToGroup = (groupId: string) =>
  `${BASE_URL}/api/prompts/groups/${groupId}/prompts`;

export const assistants = ({
  path = '',
  options,
  version,
  endpoint,
  isAvatar,
}: {
  path?: string;
  options?: object;
  endpoint?: AssistantsEndpoint;
  version: number | string;
  isAvatar?: boolean;
}) => {
  let url = isAvatar === true ? `${images()}/assistants` : `${BASE_URL}/api/assistants/v${version}`;

  if (path && path !== '') {
    url += `/${path}`;
  }

  if (endpoint) {
    options = {
      ...(options ?? {}),
      endpoint,
    };
  }

  if (options && Object.keys(options).length > 0) {
    const queryParams = new URLSearchParams(options as Record<string, string>).toString();
    url += `?${queryParams}`;
  }

  return url;
};

export const agents = ({ path = '', options }: { path?: string; options?: object }) => {
  let url = `${BASE_URL}/api/agents`;

  if (path && path !== '') {
    url += `/${path}`;
  }

  if (options && Object.keys(options).length > 0) {
    const queryParams = new URLSearchParams(options as Record<string, string>).toString();
    url += `?${queryParams}`;
  }

  return url;
};

export const activeJobs = () => `${BASE_URL}/api/agents/chat/active`;

const agentQueuedTurnsRoot = `${BASE_URL}/api/agents/chat/queued-turns`;
export const agentQueuedTurns = (protocolVersion?: 2) =>
  protocolVersion === 2 ? `${agentQueuedTurnsRoot}/v2` : agentQueuedTurnsRoot;
export const agentQueuedTurnsByConversation = (
  conversationId: string,
  clientRequestIds: string[] = [],
) => {
  const uniqueIds = Array.from(new Set(clientRequestIds)).slice(0, 100);
  const knownIds =
    uniqueIds.length > 0
      ? `&${uniqueIds.map((id) => `clientRequestIds=${encodeURIComponent(id)}`).join('&')}`
      : '';
  return `${agentQueuedTurnsRoot}?conversationId=${encodeURIComponent(conversationId)}${knownIds}`;
};
export const agentQueuedTurn = (queuedTurnId: string) =>
  `${agentQueuedTurnsRoot}/${encodeURIComponent(queuedTurnId)}`;

export const mcp = {
  tools: `${BASE_URL}/api/mcp/tools`,
  servers: `${BASE_URL}/api/mcp/servers`,
};

export const mcpServer = (serverName: string) => `${BASE_URL}/api/mcp/servers/${serverName}`;

export const revertAgentVersion = (agent_id: string) => `${agents({ path: `${agent_id}/revert` })}`;

export const files = () => `${BASE_URL}/api/files`;
export const fileUpload = () => `${BASE_URL}/api/files`;
export const fileDelete = () => `${BASE_URL}/api/files`;
export const fileDownload = (userId: string, fileId: string) =>
  `${BASE_URL}/api/files/download/${userId}/${fileId}`;

/* Deferred-preview lifecycle endpoint. Returns
 * `{ status, text?, textFormat?, previewError? }` so the frontend can
 * poll while background HTML extraction is in flight. See PR #12957. */
export const filePreview = (fileId: string) =>
  `${BASE_URL}/api/files/${encodeURIComponent(fileId)}/preview`;
export const fileConfig = () => `${BASE_URL}/api/files/config`;
/** Owner-scoped usage touch so queued attachments outlive the upload-window TTL. */
export const fileUsage = () => `${BASE_URL}/api/files/usage`;
export const agentFiles = (agentId: string) => `${BASE_URL}/api/files/agent/${agentId}`;

export const images = () => `${files()}/images`;

export const avatar = () => `${images()}/avatar`;

export const speech = () => `${files()}/speech`;

export const speechToText = () => `${speech()}/stt`;

export const textToSpeech = () => `${speech()}/tts`;

export const textToSpeechManual = () => `${textToSpeech()}/manual`;

export const textToSpeechVoices = () => `${textToSpeech()}/voices`;

export const getCustomConfigSpeech = () => `${speech()}/config/get`;

export const getPromptGroup = (_id: string) => `${prompts()}/groups/${_id}`;

export const getPromptGroupsWithFilters = (filter: object) => {
  let url = `${prompts()}/groups`;
  // Filter out undefined/null values
  const cleanedFilter = Object.entries(filter).reduce(
    (acc, [key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        acc[key] = value;
      }
      return acc;
    },
    {} as Record<string, string>,
  );

  if (Object.keys(cleanedFilter).length > 0) {
    const queryParams = new URLSearchParams(cleanedFilter).toString();
    url += `?${queryParams}`;
  }
  return url;
};

export const getPromptsWithFilters = (filter: object) => {
  let url = prompts();
  if (Object.keys(filter).length > 0) {
    const queryParams = new URLSearchParams(filter as Record<string, string>).toString();
    url += `?${queryParams}`;
  }
  return url;
};

export const getPrompt = (_id: string) => `${prompts()}/${_id}`;

export const getRandomPrompts = (limit: number, skip: number) =>
  `${prompts()}/random?limit=${limit}&skip=${skip}`;

export const postPrompt = prompts;

export const updatePromptGroup = getPromptGroup;

export const recordPromptGroupUsage = (groupId: string) => `${prompts()}/groups/${groupId}/use`;

export const updatePromptLabels = (_id: string) => `${getPrompt(_id)}/labels`;

export const updatePromptTag = (_id: string) => `${getPrompt(_id)}/tags/production`;

export const deletePromptGroup = getPromptGroup;

export const deletePrompt = ({ _id, groupId }: { _id: string; groupId: string }) => {
  return `${prompts()}/${_id}?groupId=${groupId}`;
};

export const getCategories = () => `${BASE_URL}/api/categories`;

export const getAllPromptGroups = () => `${prompts()}/all`;

/* Scheduled chats */
export const schedules = () => `${BASE_URL}/api/schedules`;
export const schedule = (id: string) => `${schedules()}/${encodeURIComponent(id)}`;
export const runSchedule = (id: string) => `${schedule(id)}/run`;

/* Skills */
export const skills = () => `${BASE_URL}/api/skills`;
export const importSkill = () => `${skills()}/import`;

export const getSkill = (id: string) => `${skills()}/${encodeURIComponent(id)}`;

export const listSkillsWithFilters = (
  filter: Record<string, string | number | undefined | null>,
) => {
  const cleaned = Object.entries(filter).reduce(
    (acc, [key, value]) => {
      if (value !== undefined && value !== null && value !== '') {
        acc[key] = String(value);
      }
      return acc;
    },
    {} as Record<string, string>,
  );
  const query =
    Object.keys(cleaned).length > 0 ? `?${new URLSearchParams(cleaned).toString()}` : '';
  return `${skills()}${query}`;
};

export const skillFiles = (id: string) => `${getSkill(id)}/files`;

export const skillFile = (id: string, relativePath: string) =>
  `${skillFiles(id)}/${encodeURIComponent(relativePath)}`;

export const insights = () => `${BASE_URL}/api/insights`;
export const insightsAccess = () => `${insights()}/access`;

/* Conversation traces */
export const conversationTrace = (conversationId: string) =>
  `${BASE_URL}/api/traces/${encodeURIComponent(conversationId)}`;
export const conversationTraceAvailability = (conversationId: string) =>
  `${conversationTrace(conversationId)}/availability`;
export const conversationTraceRecords = (conversationId: string, cursor?: string) =>
  `${conversationTrace(conversationId)}/records${
    cursor ? `?${new URLSearchParams({ cursor }).toString()}` : ''
  }`;
export const conversationTraceRecord = (
  conversationId: string,
  recordId: string,
  messageId: string,
  sourceId?: string,
) =>
  `${conversationTrace(conversationId)}/records/${encodeURIComponent(recordId)}?${new URLSearchParams(
    { message: messageId, ...(sourceId ? { source: sourceId } : {}) },
  ).toString()}`;

export const adminSkillsSync = () => `${BASE_URL}/api/admin/skills/sync`;
export const adminSkillsSyncStatus = () => `${adminSkillsSync()}/status`;
export const adminSkillsSyncRun = () => `${adminSkillsSync()}/run`;
export const adminSkillsSyncCredential = (credentialKey: string) =>
  `${adminSkillsSync()}/credentials/${encodeURIComponent(credentialKey)}`;

/**
 * Skill filesystem tree (phase 2). URL shape mirrors the original UI PR so
 * the tree hooks keep their call surface. `path` is pre-encoded by the
 * caller (e.g. `${nodeId}/content`).
 */
export const skillTree = ({ skillId, path = '' }: { skillId: string; path?: string }) => {
  let url = `${BASE_URL}/api/skills/${encodeURIComponent(skillId)}/tree`;
  if (path) {
    url += `/${path}`;
  }
  return url;
};

/* Skill active states (per-user overrides) */
export const skillStates = () => `${BASE_URL}/api/user/settings/skills/active`;

/* Langfuse connection (admin) */
export const adminLangfuseConnection = () => `${BASE_URL}/api/admin/langfuse/connection`;
export const adminLangfuseConnectionTest = () => `${adminLangfuseConnection()}/test`;
export const adminLangfuseSessionLink = (conversationId: string) =>
  `${adminLangfuseConnection()}/session/${encodeURIComponent(conversationId)}`;

/* Combined Pinned-section display order: favorite and pinned-chat entry keys interleaved. */
export const pinnedOrder = () => `${BASE_URL}/api/user/settings/pinned-order`;

/* Tool favorites (starred marketplace items) */
export const toolFavorites = () => `${BASE_URL}/api/user/settings/favorites/tools`;
export const toolFavorite = (itemType: string, itemId: string) =>
  `${toolFavorites()}/${itemType}/${encodeURIComponent(itemId)}`;

/* Roles */
export const roles = () => `${BASE_URL}/api/roles`;
export const adminRoles = () => `${BASE_URL}/api/admin/roles`;
export const getRole = (roleName: string) => `${roles()}/${encodeURIComponent(roleName)}`;
export const updatePromptPermissions = (roleName: string) => `${getRole(roleName)}/prompts`;
export const updateMemoryPermissions = (roleName: string) => `${getRole(roleName)}/memories`;
export const updateAgentPermissions = (roleName: string) => `${getRole(roleName)}/agents`;
export const updatePeoplePickerPermissions = (roleName: string) =>
  `${getRole(roleName)}/people-picker`;
export const updateMCPServersPermissions = (roleName: string) => `${getRole(roleName)}/mcp-servers`;
export const updateRemoteAgentsPermissions = (roleName: string) =>
  `${getRole(roleName)}/remote-agents`;

export const updateMarketplacePermissions = (roleName: string) =>
  `${getRole(roleName)}/marketplace`;
export const updateSkillPermissions = (roleName: string) => `${getRole(roleName)}/skills`;

/* Conversation Tags */
export const conversationTags = (tag?: string) =>
  `${BASE_URL}/api/tags${tag != null && tag ? `/${encodeURIComponent(tag)}` : ''}`;

export const conversationTagsList = (pageNumber: string, sort?: string, order?: string) =>
  `${conversationTags()}/list?pageNumber=${pageNumber}${sort ? `&sort=${sort}` : ''}${
    order ? `&order=${order}` : ''
  }`;

export const addTagToConversation = (conversationId: string) =>
  `${conversationTags()}/convo/${conversationId}`;

export const userTerms = () => `${BASE_URL}/api/user/terms`;
export const acceptUserTerms = () => `${BASE_URL}/api/user/terms/accept`;
export const banner = () => `${BASE_URL}/api/banner`;

// Message Feedback
export const feedback = (conversationId: string, messageId: string) =>
  `${BASE_URL}/api/messages/${conversationId}/${messageId}/feedback`;

// Two-Factor Endpoints
export const enableTwoFactor = () => `${BASE_URL}/api/auth/2fa/enable`;
export const verifyTwoFactor = () => `${BASE_URL}/api/auth/2fa/verify`;
export const confirmTwoFactor = () => `${BASE_URL}/api/auth/2fa/confirm`;
export const disableTwoFactor = () => `${BASE_URL}/api/auth/2fa/disable`;
export const regenerateBackupCodes = () => `${BASE_URL}/api/auth/2fa/backup/regenerate`;
export const verifyTwoFactorTemp = () => `${BASE_URL}/api/auth/2fa/verify-temp`;

/* Memories */
export const memories = () => `${BASE_URL}/api/memories`;
export const memory = (key: string, agentId?: string) =>
  `${memories()}/${encodeURIComponent(key)}${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`;
export const memoryById = (id: string, agentId?: string) =>
  `${memories()}/id/${encodeURIComponent(id)}${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`;
export const memoryPreferences = () => `${memories()}/preferences`;

export const searchPrincipals = (params: q.PrincipalSearchParams) => {
  const { q: query, limit, types } = params;
  let url = `${BASE_URL}/api/permissions/search-principals?q=${encodeURIComponent(query)}`;

  if (limit !== undefined) {
    url += `&limit=${limit}`;
  }

  if (types && types.length > 0) {
    url += `&types=${types.join(',')}`;
  }

  return url;
};

export const getAccessRoles = (resourceType: ResourceType) =>
  `${BASE_URL}/api/permissions/${resourceType}/roles`;

export const getResourcePermissions = (resourceType: ResourceType, resourceId: string) =>
  `${BASE_URL}/api/permissions/${resourceType}/${resourceId}`;

export const updateResourcePermissions = (resourceType: ResourceType, resourceId: string) =>
  `${BASE_URL}/api/permissions/${resourceType}/${resourceId}`;

export const getEffectivePermissions = (resourceType: ResourceType, resourceId: string) =>
  `${BASE_URL}/api/permissions/${resourceType}/${resourceId}/effective`;

export const getAllEffectivePermissions = (resourceType: ResourceType) =>
  `${BASE_URL}/api/permissions/${resourceType}/effective/all`;

// SharePoint Graph API Token
export const graphToken = (scopes: string) =>
  `${BASE_URL}/api/auth/graph-token?scopes=${encodeURIComponent(scopes)}`;
