/** Agent Plugins specification version implemented by this client. */
export const AGENT_PLUGINS_VERSION = '1.0.0';

export const PLUGIN_MANIFEST_SCHEMA_ID =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
export const PLUGIN_MCP_SCHEMA_ID = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

export const PLUGIN_MANIFEST_FILE = 'plugin.json';
export const PLUGIN_MCP_FILE = 'mcp.json';
export const PLUGIN_SKILLS_DIR = 'skills';
export const SKILL_MANIFEST_FILE = 'SKILL.md';

/**
 * LibreChat's reverse-domain extension namespace. Owns both the `extensions`
 * manifest key and the top-level extension directory of the same name.
 */
export const LIBRECHAT_EXTENSION_NAMESPACE = 'ai.librechat';
export const EXTENSION_HOOKS_FILE = 'hooks/hooks.json';

export const PLUGIN_ROOT_VAR = 'PLUGIN_ROOT';
export const PLUGIN_DATA_VAR = 'PLUGIN_DATA';

export const DEPLOYMENT_PLUGIN_HOOKS_ENV = 'DEPLOYMENT_PLUGIN_HOOKS';
export const DEPLOYMENT_PLUGINS_DIR_ENV = 'DEPLOYMENT_PLUGINS_DIR';
export const DEFAULT_DEPLOYMENT_PLUGINS_DIR = 'plugin';
export const DEPLOYMENT_PLUGIN_DATA_DIR_ENV = 'DEPLOYMENT_PLUGIN_DATA_DIR';
export const DEFAULT_DEPLOYMENT_PLUGIN_DATA_DIR = 'data/plugins';

export const MAX_PLUGIN_NAME_LENGTH = 64;
