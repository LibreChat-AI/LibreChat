import type { AccessRoleIds } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';

/**
 * Centralized mapping for role localizations
 * Maps role IDs to their localization keys
 */
export const ROLE_LOCALIZATIONS = {
  agent_viewer: {
    name: 'com_ui_role_viewer' as const,
    description: 'com_ui_role_viewer_desc' as const,
  } as const,
  agent_editor: {
    name: 'com_ui_role_editor' as const,
    description: 'com_ui_role_editor_desc' as const,
  } as const,
  agent_manager: {
    name: 'com_ui_role_manager' as const,
    description: 'com_ui_role_manager_desc' as const,
  } as const,
  agent_owner: {
    name: 'com_ui_role_owner' as const,
    description: 'com_ui_role_owner_desc' as const,
  } as const,
  // PromptGroup roles
  promptGroup_viewer: {
    name: 'com_ui_role_viewer' as const,
    description: 'com_ui_role_viewer_desc' as const,
  } as const,
  promptGroup_editor: {
    name: 'com_ui_role_editor' as const,
    description: 'com_ui_role_editor_desc' as const,
  } as const,
  promptGroup_owner: {
    name: 'com_ui_role_owner' as const,
    description: 'com_ui_role_owner_desc' as const,
  } as const,
  // MCPServer roles
  mcpServer_viewer: {
    name: 'com_ui_mcp_server_role_viewer' as const,
    description: 'com_ui_mcp_server_role_viewer_desc' as const,
  } as const,
  mcpServer_editor: {
    name: 'com_ui_mcp_server_role_editor' as const,
    description: 'com_ui_mcp_server_role_editor_desc' as const,
  } as const,
  mcpServer_owner: {
    name: 'com_ui_mcp_server_role_owner' as const,
    description: 'com_ui_mcp_server_role_owner_desc' as const,
  } as const,
  remoteAgent_viewer: {
    name: 'com_ui_remote_agent_role_viewer' as const,
    description: 'com_ui_remote_agent_role_viewer_desc' as const,
  } as const,
  remoteAgent_editor: {
    name: 'com_ui_remote_agent_role_editor' as const,
    description: 'com_ui_remote_agent_role_editor_desc' as const,
  } as const,
  remoteAgent_owner: {
    name: 'com_ui_remote_agent_role_owner' as const,
    description: 'com_ui_remote_agent_role_owner_desc' as const,
  } as const,
  // Skill roles — reuse the generic role names; descriptions are skill-specific.
  skill_viewer: {
    name: 'com_ui_role_viewer' as const,
    description: 'com_ui_skill_role_viewer_desc' as const,
  } as const,
  skill_editor: {
    name: 'com_ui_role_editor' as const,
    description: 'com_ui_skill_role_editor_desc' as const,
  } as const,
  skill_owner: {
    name: 'com_ui_role_owner' as const,
    description: 'com_ui_skill_role_owner_desc' as const,
  } as const,
  // Shared link roles
  sharedLink_viewer: {
    name: 'com_ui_role_viewer' as const,
    description: 'com_ui_role_viewer_desc' as const,
  } as const,
  sharedLink_owner: {
    name: 'com_ui_role_owner' as const,
    description: 'com_ui_role_owner_desc' as const,
  } as const,
};

/**
 * Get localization keys for a given role ID
 * @param roleId - The role ID to get localization keys for
 * @returns Object with name and description localization keys, or unknown keys if not found
 */
export const getRoleLocalizationKeys = (
  roleId: AccessRoleIds,
): {
  name: TranslationKeys;
  description: TranslationKeys;
} => {
  return ROLE_LOCALIZATIONS[roleId] || { name: 'com_ui_unknown', description: 'com_ui_unknown' };
};
