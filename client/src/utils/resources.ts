import { AccessRoleIds, ResourceType } from 'librechat-data-provider';
import type { TranslationKeys } from '~/hooks/useLocalize';

export interface ResourceConfig {
  resourceType: ResourceType;
  allowRoleSelection?: boolean;
  defaultViewerRoleId: AccessRoleIds;
  defaultEditorRoleId: AccessRoleIds;
  defaultOwnerRoleId: AccessRoleIds;
  getResourceUrl?: (resourceId: string) => string;
  getResourceName: (resourceName?: string) => string;
  getShareMessage: (resourceName?: string) => string;
  getManageMessage: (resourceName?: string) => string;
  copyUrlMessageKey: TranslationKeys;
}

export const RESOURCE_CONFIGS: Partial<Record<ResourceType, ResourceConfig>> = {
  [ResourceType.AGENT]: {
    resourceType: ResourceType.AGENT,
    defaultViewerRoleId: AccessRoleIds.AGENT_VIEWER,
    defaultEditorRoleId: AccessRoleIds.AGENT_EDITOR,
    defaultOwnerRoleId: AccessRoleIds.AGENT_OWNER,
    getResourceUrl: (agentId: string) => `${window.location.origin}/c/new?agent_id=${agentId}`,
    getResourceName: (name?: string) => (name && name !== '' ? name : 'agent'),
    getShareMessage: (name?: string) => (name && name !== '' ? name : 'agent'),
    getManageMessage: (name?: string) =>
      `Manage permissions for ${name && name !== '' ? name : 'agent'}`,
    copyUrlMessageKey: 'com_ui_agent_url_copied',
  },
  [ResourceType.PROMPTGROUP]: {
    resourceType: ResourceType.PROMPTGROUP,
    defaultViewerRoleId: AccessRoleIds.PROMPTGROUP_VIEWER,
    defaultEditorRoleId: AccessRoleIds.PROMPTGROUP_EDITOR,
    defaultOwnerRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
    getResourceName: (name?: string) => (name && name !== '' ? name : 'prompt'),
    getShareMessage: (name?: string) => (name && name !== '' ? name : 'prompt'),
    getManageMessage: (name?: string) =>
      `Manage permissions for ${name && name !== '' ? name : 'prompt'}`,
    copyUrlMessageKey: 'com_ui_prompt_url_copied',
  },
  [ResourceType.MCPSERVER]: {
    resourceType: ResourceType.MCPSERVER,
    defaultViewerRoleId: AccessRoleIds.MCPSERVER_VIEWER,
    defaultEditorRoleId: AccessRoleIds.MCPSERVER_EDITOR,
    defaultOwnerRoleId: AccessRoleIds.MCPSERVER_OWNER,
    getResourceName: (name?: string) => (name && name !== '' ? name : 'MCP server'),
    getShareMessage: (name?: string) => (name && name !== '' ? name : 'MCP server'),
    getManageMessage: (name?: string) =>
      `Manage permissions for ${name && name !== '' ? name : 'MCP server'}`,
    copyUrlMessageKey: 'com_ui_mcp_server_url_copied',
  },
  [ResourceType.REMOTE_AGENT]: {
    resourceType: ResourceType.REMOTE_AGENT,
    defaultViewerRoleId: AccessRoleIds.REMOTE_AGENT_VIEWER,
    defaultEditorRoleId: AccessRoleIds.REMOTE_AGENT_EDITOR,
    defaultOwnerRoleId: AccessRoleIds.REMOTE_AGENT_OWNER,
    getResourceUrl: () => `${window.location.origin}/api/v1/responses`,
    getResourceName: (name?: string) => (name && name !== '' ? `"${name}"` : 'remote agent'),
    getShareMessage: (name?: string) =>
      name && name !== '' ? `"${name}" (API Access)` : 'remote agent access',
    getManageMessage: (name?: string) =>
      `Manage API access for ${name && name !== '' ? `"${name}"` : 'agent'}`,
    copyUrlMessageKey: 'com_ui_api_endpoint_copied',
  },
  [ResourceType.SKILL]: {
    resourceType: ResourceType.SKILL,
    defaultViewerRoleId: AccessRoleIds.SKILL_VIEWER,
    defaultEditorRoleId: AccessRoleIds.SKILL_EDITOR,
    defaultOwnerRoleId: AccessRoleIds.SKILL_OWNER,
    getResourceName: (name?: string) => (name && name !== '' ? name : 'skill'),
    getShareMessage: (name?: string) => (name && name !== '' ? name : 'skill'),
    getManageMessage: (name?: string) =>
      `Manage permissions for ${name && name !== '' ? name : 'skill'}`,
    copyUrlMessageKey: 'com_ui_skill_url_copied',
  },
  [ResourceType.SHARED_LINK]: {
    resourceType: ResourceType.SHARED_LINK,
    defaultViewerRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
    defaultEditorRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
    defaultOwnerRoleId: AccessRoleIds.SHARED_LINK_OWNER,
    getResourceName: (name?: string) => name || 'shared link',
    getShareMessage: (name?: string) => name || 'shared link',
    getManageMessage: (name?: string) => `Manage access for ${name || 'shared link'}`,
    copyUrlMessageKey: 'com_ui_link_copied',
  },
  [ResourceType.ARTIFACT_APP]: {
    resourceType: ResourceType.ARTIFACT_APP,
    allowRoleSelection: false,
    defaultViewerRoleId: AccessRoleIds.ARTIFACT_APP_VIEWER,
    defaultEditorRoleId: AccessRoleIds.ARTIFACT_APP_EDITOR,
    defaultOwnerRoleId: AccessRoleIds.ARTIFACT_APP_OWNER,
    getResourceUrl: (artifactId: string) => `${window.location.origin}/apps/${artifactId}`,
    getResourceName: (name?: string) => name || 'artifact',
    getShareMessage: (name?: string) => name || 'artifact',
    getManageMessage: (name?: string) => `Manage access for ${name || 'artifact'}`,
    copyUrlMessageKey: 'com_ui_artifact_link_copied',
  },
};

export const getResourceConfig = (resourceType: ResourceType): ResourceConfig | undefined => {
  return RESOURCE_CONFIGS[resourceType];
};
