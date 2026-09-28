import type { InfiniteData } from '@tanstack/react-query';
import type { RerankerTypes, SearchProviders, ScraperProviders } from '../config';
import type * as p from '../accessPermissions';
import type * as a from '../types/agents';
import type * as s from '../schemas';
import type * as t from '../types';

export type Conversation = {
  id: string;
  createdAt: number;
  participants: string[];
  lastMessage: string;
  conversations: s.TConversation[];
};

export type ConversationListParams = {
  cursor?: string;
  limit?: number;
  isArchived?: boolean;
  pinned?: boolean;
  sortBy?: 'title' | 'createdAt' | 'updatedAt' | 'archivedAt';
  sortDirection?: 'asc' | 'desc';
  tags?: string[];
  search?: string;
  projectId?: string;
};

export type MinimalConversation = Pick<
  s.TConversation,
  | 'conversationId'
  | 'endpoint'
  | 'title'
  | 'createdAt'
  | 'updatedAt'
  | 'archivedAt'
  | 'isArchived'
  | 'user'
  | 'chatProjectId'
  | 'pinned'
>;

export type ConversationListResponse = {
  conversations: MinimalConversation[];
  nextCursor: string | null;
};

export type ConversationData = InfiniteData<ConversationListResponse>;
export type ConversationUpdater = (
  data: ConversationData,
  conversation: s.TConversation,
) => ConversationData;

export type ProjectListParams = {
  cursor?: string;
  limit?: number;
  sortBy?: 'name' | 'createdAt' | 'lastConversationAt';
  sortDirection?: 'asc' | 'desc';
  search?: string;
};

export type ProjectListResponse = {
  projects: t.TChatProject[];
  nextCursor: string | null;
};

export type ProjectData = InfiniteData<ProjectListResponse>;

/* Messages */
export type MessagesListParams = {
  cursor?: string | null;
  sortBy?: 'endpoint' | 'createdAt' | 'updatedAt';
  sortDirection?: 'asc' | 'desc';
  pageSize?: number;
  conversationId?: string;
  messageId?: string;
  search?: string;
};

export type MessagesListResponse = {
  messages: s.TMessage[];
  nextCursor: string | null;
};

/* Shared Links */
export type SharedMessagesResponse = Omit<s.TSharedLink, 'messages'> & {
  messages: s.TMessage[];
};

export interface SharedLinksListParams {
  pageSize: number;
  sortBy: 'title' | 'createdAt';
  sortDirection: 'asc' | 'desc';
  search?: string;
  cursor?: string;
}

export type SharedLinkItem = {
  shareId: string;
  title: string;
  createdAt: string;
  conversationId: string;
};

export interface SharedLinksResponse {
  links: SharedLinkItem[];
  nextCursor: string | null;
  hasNextPage: boolean;
}

export interface SharedLinkQueryData {
  pages: SharedLinksResponse[];
  pageParams: (string | null)[];
}

export type AllPromptGroupsFilterRequest = {
  category: string;
  pageNumber: string;
  pageSize: string | number;
  before?: string | null;
  after?: string | null;
  order?: 'asc' | 'desc';
  name?: string;
  author?: string;
};

export type AllPromptGroupsResponse = t.TPromptGroup[];

export type ConversationTagsResponse = s.TConversationTag[];

/* MCP Types */
export type MCPTool = {
  name: string;
  pluginKey: string;
  description: string;
  /** Raw upstream tool name when the model-facing key stripped a redundant
   *  server-name prefix — gates the agent editor's legacy id migration. */
  serverToolName?: string;
};

export type MCPServer = {
  name: string;
  icon: string;
  authenticated: boolean;
  /** Passive discovery found that stored OAuth authorization must be renewed. */
  authorizationState?: 'reauth_required';
  /** Shared credential/catalog generation observed by passive discovery. */
  authorizationGeneration?: string;
  authConfig: s.TPluginAuthConfig[];
  tools: MCPTool[];
};

export type MCPServersResponse = {
  servers: Record<string, MCPServer>;
};

export type VerifyToolAuthParams = { toolId: string };
export type VerifyToolAuthResponse = {
  authenticated: boolean;
  message?: string | s.AuthType;
  authTypes?: [string, s.AuthType][];
  searchProvider?: SearchProviders;
  scraperProvider?: ScraperProviders;
  rerankerType?: RerankerTypes;
};

export type GetToolCallParams = { conversationId: string };
export type ToolCallResults = a.ToolCallResult[];

/* Memories */
export type TUserMemory = {
  /** Stable stored record identifier retained when content fields are redacted. */
  _id?: string;
  key: string;
  value: string;
  /** Optional generated or legacy summary content. */
  summary?: string;
  updated_at: string;
  tokenCount?: number;
  /** Agent partition this memory belongs to; absent = shared personal pool */
  agentId?: string;
  /** Display name of the partition's agent, resolved server-side when available */
  agentName?: string;
  /** Current policy removed one or more memory content fields from this response. */
  contentFilterBlocked?: boolean;
};

export type MemoriesResponse = {
  memories: TUserMemory[];
  totalTokens: number;
  tokenLimit: number | null;
  usagePercentage: number | null;
};

export type UpdateMemoryResponse = {
  updated: boolean;
  memory: TUserMemory;
};

export type DeleteMemoryResponse = {
  deleted: boolean;
};

export type PrincipalSearchParams = {
  q: string;
  limit?: number;
  types?: Array<p.PrincipalType.USER | p.PrincipalType.GROUP | p.PrincipalType.ROLE>;
};

export type PrincipalSearchResponse = {
  query: string;
  limit: number;
  types?: Array<p.PrincipalType.USER | p.PrincipalType.GROUP | p.PrincipalType.ROLE>;
  results: p.TPrincipalSearchResult[];
  count: number;
  sources: {
    local: number;
    entra: number;
  };
};

export type AccessRole = {
  accessRoleId: p.AccessRoleIds;
  name: string;
  description: string;
  permBits: number;
};

export type AccessRolesResponse = AccessRole[];

export type ListRolesResponse = {
  roles: Array<{ _id?: string; name: string; description?: string }>;
  total: number;
  limit: number;
  offset?: number;
};

export interface MCPServerStatus {
  requiresOAuth: boolean;
  /** The server connects only inside a chat request because its config reads BODY placeholders. */
  requestScoped?: boolean;
  /** Whether all declared per-user variables are present for an on-demand connection. */
  configurationState?: 'configured' | 'needs_configuration';
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'error';
  authorizationState?:
    | 'not_required'
    | 'authorizing'
    | 'authorized'
    | 'needs_authorization'
    | 'error';
  /** Shared credential/catalog generation observed by the status endpoint. */
  authorizationGeneration?: string;
}

export interface MCPConnectionStatusResponse {
  success: boolean;
  connectionStatus: Record<string, MCPServerStatus>;
  /** Server-configured OAuth completion window in ms (`MCP_OAUTH_HANDLING_TIMEOUT`) */
  oauthTimeout?: number;
}

export interface MCPServerConnectionStatusResponse {
  success: boolean;
  serverName: string;
  requiresOAuth: boolean;
  requestScoped?: boolean;
  configurationState?: MCPServerStatus['configurationState'];
  connectionStatus: 'disconnected' | 'connecting' | 'connected' | 'error';
  authorizationState?: MCPServerStatus['authorizationState'];
  authorizationGeneration?: string;
}

export interface MCPAuthValuesResponse {
  success: boolean;
  serverName: string;
  authValueFlags: Record<string, boolean>;
}

/**
 * User Favorites — pinned agents, models, and model specs.
 * Exactly one variant should be set per entry; exclusivity is enforced
 * server-side in FavoritesController. Shape is loose for state-update ergonomics.
 */
export type TUserFavorite = {
  agentId?: string;
  model?: string;
  endpoint?: string;
  spec?: string;
};

/**
 * Tool favorites — starred marketplace items (built-in capabilities, plugin
 * tools, MCP servers, skills). Identity is the compound (itemType, itemId)
 * pair, matching the marketplace `itemKey` format `itemType:itemId`.
 */
export type TToolFavoriteType = 'builtin' | 'tool' | 'mcp' | 'skill';

export type TToolFavorite = {
  itemType: TToolFavoriteType;
  itemId: string;
};

/* SharePoint Graph API Token */
export type GraphTokenParams = {
  scopes: string;
};

export type GraphTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope: string;
};
