import { z } from 'zod';

/**
 * Granular Permission System Types for Agent Sharing
 *
 * This file contains TypeScript interfaces and Zod schemas for the enhanced
 * agent permission system that supports sharing with specific users/groups
 * and Entra ID integration.
 */

// ===== ENUMS & CONSTANTS =====

/**
 * Principal types for permission system
 */
export enum PrincipalType {
  USER = 'user',
  GROUP = 'group',
  PUBLIC = 'public',
  ROLE = 'role',
}

/**
 * Principal model types for MongoDB references
 */
export enum PrincipalModel {
  USER = 'User',
  GROUP = 'Group',
  ROLE = 'Role',
}

/**
 * Resource types for permission system
 */
export enum ResourceType {
  AGENT = 'agent',
  CODE_ENVIRONMENT = 'codeEnvironment',
  PROMPTGROUP = 'promptGroup',
  MCPSERVER = 'mcpServer',
  REMOTE_AGENT = 'remoteAgent',
  SKILL = 'skill',
  SHARED_LINK = 'sharedLink',
}

/**
 * Permission bit constants for bitwise operations
 */
export enum PermissionBits {
  /** 001 - Can view and use agent */
  VIEW = 1,
  /**  010 - Can modify agent settings */
  EDIT = 2,
  /**  100 - Can delete agent */
  DELETE = 4,
  /**  1000 - Can share agent with others (future) */
  SHARE = 8,
  /** 10000 - Can view Insights data for an agent when VIEW is also present */
  VIEW_INSIGHTS = 16,
}

/**
 * Standard access role IDs
 */
export enum AccessRoleIds {
  AGENT_VIEWER = 'agent_viewer',
  AGENT_EDITOR = 'agent_editor',
  AGENT_OWNER = 'agent_owner',
  CODE_ENVIRONMENT_VIEWER = 'codeEnvironment_viewer',
  CODE_ENVIRONMENT_EDITOR = 'codeEnvironment_editor',
  CODE_ENVIRONMENT_OWNER = 'codeEnvironment_owner',
  PROMPTGROUP_VIEWER = 'promptGroup_viewer',
  PROMPTGROUP_EDITOR = 'promptGroup_editor',
  PROMPTGROUP_OWNER = 'promptGroup_owner',
  MCPSERVER_VIEWER = 'mcpServer_viewer',
  MCPSERVER_EDITOR = 'mcpServer_editor',
  MCPSERVER_OWNER = 'mcpServer_owner',
  REMOTE_AGENT_VIEWER = 'remoteAgent_viewer',
  REMOTE_AGENT_EDITOR = 'remoteAgent_editor',
  REMOTE_AGENT_OWNER = 'remoteAgent_owner',
  SKILL_VIEWER = 'skill_viewer',
  SKILL_EDITOR = 'skill_editor',
  SKILL_OWNER = 'skill_owner',
  SHARED_LINK_VIEWER = 'sharedLink_viewer',
  SHARED_LINK_OWNER = 'sharedLink_owner',
}

// ===== ZOD SCHEMAS =====

/**
 * Principal schema - represents a user, group, role, or public access
 */
export const principalSchema = z.object({
  type: z.nativeEnum(PrincipalType),
  id: z.string().optional(), // undefined for 'public' type, role name for 'role' type
  name: z.string().optional(),
  email: z.string().optional(), // for user and group types
  source: z.enum(['local', 'entra']).optional(),
  avatar: z.string().optional(), // for user and group types
  description: z.string().optional(), // for group and role types
  idOnTheSource: z.string().optional(), // Entra ID for users/groups
  accessRoleId: z.nativeEnum(AccessRoleIds).optional(), // Access role ID for permissions
  viewInsights: z.boolean().optional(),
  isAdmin: z.boolean().optional(),
  memberCount: z.number().optional(), // for group type
});

/**
 * Access role schema - defines named permission sets
 */
export const accessRoleSchema = z.object({
  accessRoleId: z.nativeEnum(AccessRoleIds),
  name: z.string(),
  description: z.string().optional(),
  resourceType: z.nativeEnum(ResourceType).default(ResourceType.AGENT),
  permBits: z.number(),
});

/**
 * Update resource permissions request schema
 * This matches the user's requirement for the frontend DTO structure
 */
export const updateResourcePermissionsRequestSchema = z.object({
  updated: principalSchema.array(),
  removed: principalSchema.array(),
  public: z.boolean().optional(),
  publicAccessRoleId: z.string().optional(),
});

/**
 * Update resource permissions response schema
 * Returns the updated permissions with accessRoleId included
 */
export const updateResourcePermissionsResponseSchema = z.object({
  message: z.string(),
  results: z.object({
    principals: principalSchema.array(),
    public: z.boolean().optional(),
    publicAccessRoleId: z.string().optional(),
  }),
});

// ===== TYPESCRIPT TYPES =====

/**
 * Principal - represents a user, group, or public access
 */
export type TPrincipal = z.infer<typeof principalSchema>;

/**
 * Access role - defines named permission sets
 */
export type TAccessRole = z.infer<typeof accessRoleSchema>;

/**
 * Update resource permissions request
 * This matches the user's requirement for the frontend DTO structure
 */
export type TUpdateResourcePermissionsRequest = z.infer<
  typeof updateResourcePermissionsRequestSchema
>;

/**
 * Update resource permissions response
 * Returns the updated permissions with accessRoleId included
 */
export type TUpdateResourcePermissionsResponse = z.infer<
  typeof updateResourcePermissionsResponseSchema
>;

/**
 * Principal search result item
 */
export type TPrincipalSearchResult = {
  id?: string | null; // null for Entra ID principals that don't exist locally yet
  type: PrincipalType.USER | PrincipalType.GROUP | PrincipalType.ROLE;
  name: string;
  email?: string; // for users and groups
  username?: string; // for users
  avatar?: string; // for users and groups
  provider?: string; // for users
  source: 'local' | 'entra';
  memberCount?: number; // for groups
  description?: string; // for groups
  idOnTheSource?: string; // Entra ID for users (maps to openidId) and groups (maps to idOnTheSource)
  isAdmin?: boolean;
};

/**
 * Principal search response
 */
export type TPrincipalSearchResponse = {
  query: string;
  limit: number;
  types?: Array<PrincipalType.USER | PrincipalType.GROUP | PrincipalType.ROLE> | null;
  results: TPrincipalSearchResult[];
  count: number;
  sources: {
    local: number;
    entra: number;
  };
};

/**
 * Get resource permissions response schema
 * This matches the enhanced aggregation-based endpoint response format
 */
export const getResourcePermissionsResponseSchema = z.object({
  resourceType: z.nativeEnum(ResourceType),
  resourceId: z.nativeEnum(AccessRoleIds),
  principals: z.array(principalSchema),
  public: z.boolean(),
  publicAccessRoleId: z.nativeEnum(AccessRoleIds).optional(),
});

/**
 * Get resource permissions response type
 * This matches the enhanced aggregation-based endpoint response format
 */
export type TGetResourcePermissionsResponse = z.infer<typeof getResourcePermissionsResponseSchema>;

/**
 * Effective permissions response schema
 * Returns just the permission bitmask for a user on a resource
 */
export const effectivePermissionsResponseSchema = z.object({
  permissionBits: z.number(),
});

/**
 * Effective permissions response type
 * Returns just the permission bitmask for a user on a resource
 */
export type TEffectivePermissionsResponse = z.infer<typeof effectivePermissionsResponseSchema>;

/**
 * All effective permissions response type
 * Map of resourceId to permissionBits for all accessible resources
 */
export type TAllEffectivePermissionsResponse = Record<string, number>;

// ===== HELPER FUNCTIONS =====

/**
 * Check if permission bitmask contains other bitmask
 * @param permissions - The permission bitmask to check
 * @param requiredPermission - The required permission bit(s)
 * @returns {boolean} Whether permissions contains requiredPermission
 */
export function hasPermissions(permissions: number, requiredPermission: number): boolean {
  return (permissions & requiredPermission) === requiredPermission;
}
