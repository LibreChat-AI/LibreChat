import type { MCPOptions, MCPServerUserInput } from '../mcp';

/**
 * Base MCP Server interface
 * Core structure shared between API and database layers
 */
export interface IMCPServerDB {
  _id?: string; // MongoDB ObjectId (used for ACL/permissions)
  serverName: string;
  config: MCPOptions;
  author?: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * User-managed MCP Server (standalone, not attached to agent)
 * API type for frontend/backend communication
 * Similar to Agent type - includes populated author fields
 */
export type MCPServerDB = IMCPServerDB;

/**
 * Parameters for creating a new user-managed MCP server
 * Note: Only UI-editable fields are allowed (excludes server-managed fields)
 */
export type MCPServerCreateParams = {
  config: MCPServerUserInput; // UI fields only (title, description, url, oauth, iconPath)
};

/**
 * Parameters for updating an existing user-managed MCP server
 * Note: Only UI-editable fields are allowed (excludes server-managed fields)
 */
export type MCPServerUpdateParams = {
  config?: MCPServerUserInput; // UI fields only (title, description, url, oauth, iconPath)
};

/**
 * Response for MCP server list endpoint
 */
export type MCPServerDBObjectResponse = {
  dbId?: string;
  serverName: string;
  /** True if access is only via agent (not directly shared with user) */
  consumeOnly?: boolean;
  /** True when chat request fields are required before the server can connect. */
  requestScoped?: boolean;
} & MCPOptions;

export type MCPServersListResponse = Record<string, MCPServerDBObjectResponse>;

export type MCPReinitializeFailureReason =
  | 'unreachable'
  | 'missing_custom_user_vars'
  | 'oauth_required'
  | 'initialization_failed';

export interface MCPReinitializeResponse {
  success: boolean;
  message: string;
  serverName: string;
  oauthRequired?: boolean;
  oauthUrl?: string | null;
  /** Shared OAuth attempt identifier used to poll durable flow state. */
  flowId?: string;
  /** Remaining OAuth completion window for this attempt, in milliseconds. */
  oauthTimeout?: number;
  failureReason?: MCPReinitializeFailureReason;
  missingUserVars?: string[];
  /** True when the server uses request-scoped placeholders and the connection
   *  was deferred to the next chat turn (tools are not enumerable up front). */
  connectionDeferred?: boolean;
}

export interface MCPOAuthStatusResponse {
  status: 'PENDING' | 'COMPLETED' | 'FAILED';
  completed: boolean;
  failed: boolean;
  error?: string;
}
