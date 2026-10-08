import type { MCPOptions } from 'librechat-data-provider';
import type { PluginHookPlan, PluginHooksDocument } from '~/agents/hooks';
import type { MCP_PLUGIN_SOURCE } from '~/utils/env';
import type { JsonValue } from '~/agents/envelope';
import type { DeploymentSkill } from '~/skills';

export type PluginDiagnosticSeverity = 'error' | 'warning';

export type PluginDiagnosticCode =
  | 'manifest_missing'
  | 'manifest_unreadable'
  | 'manifest_invalid_json'
  | 'manifest_invalid'
  | 'manifest_unknown_field'
  | 'manifest_unsupported_version'
  | 'manifest_name_conflict'
  | 'data_directory_unavailable'
  | 'extensions_invalid'
  | 'path_escape'
  | 'component_location_invalid'
  | 'skill_invalid'
  | 'mcp_unreadable'
  | 'mcp_invalid_json'
  | 'mcp_invalid'
  | 'mcp_version_mismatch'
  | 'mcp_server_invalid'
  | 'mcp_transport_unsupported'
  | 'hooks_invalid'
  | 'hooks_unsupported';

export interface PluginDiagnostic {
  code: PluginDiagnosticCode;
  severity: PluginDiagnosticSeverity;
  message: string;
  /** Plugin-relative location the diagnostic refers to, when one applies. */
  location?: string;
}

/** Contents of one client extension namespace; JSON that this client does not validate (§8.1). */
export type PluginExtensionData = Record<string, JsonValue>;

export interface PluginAuthor {
  name?: string;
  email?: string;
  url?: string;
}

export interface PluginManifest {
  $schema: string;
  name: string;
  version?: string;
  description?: string;
  author?: PluginAuthor;
  homepage?: string;
  repository?: string;
  license?: string;
  keywords?: string[];
  extensions?: Record<string, PluginExtensionData>;
}

/**
 * Plugin MCP options always carry their provenance so the connection layer can
 * tell them apart from operator-authored config and leave every placeholder the
 * plugin declared literal.
 */
export type PluginMcpOptions = MCPOptions & { source: typeof MCP_PLUGIN_SOURCE };

export interface PluginMcpServer {
  /** Server name as declared in the plugin's `mcpServers` object. */
  name: string;
  options: PluginMcpOptions;
}

/** Hooks contributed through the `ai.librechat` extension directory. */
export interface PluginHookContribution {
  plan: PluginHookPlan;
  /** Parsed source document, re-planned at registration so plan and runtime never drift. */
  document: PluginHooksDocument;
  location: string;
}

export interface LoadedPlugin {
  /** Filesystem-resolved plugin root. */
  root: string;
  /** Client-managed persistent data directory supplied to plugin subprocesses. */
  dataDirectory: string;
  manifest: PluginManifest;
  skills: DeploymentSkill[];
  mcpServers: PluginMcpServer[];
  hooks?: PluginHookContribution;
  diagnostics: PluginDiagnostic[];
}

export type PluginLoadResult =
  | { status: 'loaded'; plugin: LoadedPlugin }
  | { status: 'rejected'; root: string; diagnostics: PluginDiagnostic[] };
