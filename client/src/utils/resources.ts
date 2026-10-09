import { AccessRoleIds, ResourceType } from 'librechat-data-provider';

export interface ResourceConfig {
  resourceType: ResourceType;
  defaultViewerRoleId: AccessRoleIds;
  defaultEditorRoleId: AccessRoleIds;
  defaultOwnerRoleId: AccessRoleIds;
  getResourceUrl?: (resourceId: string) => string;
  getResourceName: (resourceName?: string) => string;
  getShareMessage: (resourceName?: string) => string;
  getManageMessage: (resourceName?: string) => string;
  getCopyUrlMessage: () => string;
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
    getCopyUrlMessage: () => 'Agent URL copied',
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
    getCopyUrlMessage: () => 'Prompt URL copied',
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
    getCopyUrlMessage: () => 'MCP Server URL copied',
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
    getCopyUrlMessage: () => 'API endpoint copied',
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
    getCopyUrlMessage: () => 'Skill URL copied',
  },
  [ResourceType.SHARED_LINK]: {
    resourceType: ResourceType.SHARED_LINK,
    defaultViewerRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
    defaultEditorRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
    defaultOwnerRoleId: AccessRoleIds.SHARED_LINK_OWNER,
    getResourceName: (name?: string) => name || 'shared link',
    getShareMessage: (name?: string) => name || 'shared link',
    getManageMessage: (name?: string) => `Manage access for ${name || 'shared link'}`,
    getCopyUrlMessage: () => 'Share link copied',
  },
};

export const getResourceConfig = (resourceType: ResourceType): ResourceConfig | undefined => {
  return RESOURCE_CONFIGS[resourceType];
};
