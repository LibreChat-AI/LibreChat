import fs from 'fs';
import path from 'path';
import { logger } from '@librechat/data-schemas';
import type { MCPOptions } from 'librechat-data-provider';
import type { LoadedPlugin, PluginDiagnostic } from './types';
import type { PluginHookCapabilities } from '~/agents/hooks';
import type { DeploymentSkill } from '~/skills';
import {
  DEPLOYMENT_PLUGINS_DIR_ENV,
  DEFAULT_DEPLOYMENT_PLUGINS_DIR,
  DEPLOYMENT_PLUGIN_DATA_DIR_ENV,
  DEFAULT_DEPLOYMENT_PLUGIN_DATA_DIR,
} from './constants';
import { loadPlugin } from './load';

export interface DeploymentPluginOptions {
  projectRoot?: string;
  env?: NodeJS.ProcessEnv;
  hookCapabilities?: PluginHookCapabilities;
}

interface DirectoryResolution {
  directory: string;
  explicitlyConfigured: boolean;
}

function resolveDirectory(
  envKey: string,
  fallback: string,
  options: DeploymentPluginOptions,
): DirectoryResolution {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot ?? process.cwd();
  const configured = env[envKey]?.trim();
  const raw = configured && configured.length > 0 ? configured : fallback;
  return {
    directory: path.isAbsolute(raw) ? raw : path.resolve(projectRoot, raw),
    explicitlyConfigured: configured != null && configured.length > 0,
  };
}

export function resolveDeploymentPluginDirectory(
  options: DeploymentPluginOptions = {},
): DirectoryResolution {
  return resolveDirectory(DEPLOYMENT_PLUGINS_DIR_ENV, DEFAULT_DEPLOYMENT_PLUGINS_DIR, options);
}

export function resolveDeploymentPluginDataDirectory(
  options: DeploymentPluginOptions = {},
): string {
  return resolveDirectory(
    DEPLOYMENT_PLUGIN_DATA_DIR_ENV,
    DEFAULT_DEPLOYMENT_PLUGIN_DATA_DIR,
    options,
  ).directory;
}

/**
 * Holds the plugins installed by the operator. Names are unique across the
 * registry: a later plugin declaring an already-claimed plugin name, skill
 * name, or MCP server name loses and the conflict is reported.
 */
export class DeploymentPluginRegistry {
  private readonly plugins: LoadedPlugin[] = [];
  private readonly pluginsByName = new Map<string, LoadedPlugin>();
  private readonly skillsByName = new Map<string, DeploymentSkill>();
  private readonly serversByName = new Map<string, MCPOptions>();
  private readonly rejections: PluginDiagnostic[] = [];

  constructor(
    private readonly directory: string | null,
    loaded: LoadedPlugin[] = [],
  ) {
    for (const plugin of loaded) {
      this.add(plugin);
    }
  }

  private add(plugin: LoadedPlugin): void {
    /**
     * `PLUGIN_DATA` is derived from the manifest name, so two packages claiming
     * one name would share a persistent directory and overwrite each other's
     * state. The later package is refused before any of its components land.
     */
    const claimed = this.pluginsByName.get(plugin.manifest.name);
    if (claimed !== undefined) {
      this.rejections.push({
        code: 'manifest_name_conflict',
        severity: 'error',
        message: `Plugin name "${plugin.manifest.name}" is already claimed by ${claimed.root}; this package was skipped`,
        location: plugin.root,
      });
      return;
    }
    this.pluginsByName.set(plugin.manifest.name, plugin);

    for (const skill of plugin.skills) {
      if (this.skillsByName.has(skill.name)) {
        plugin.diagnostics.push({
          code: 'skill_invalid',
          severity: 'warning',
          message: `Skill "${skill.name}" is already provided by another plugin and was skipped`,
          location: `${plugin.manifest.name}/skills/${skill.name}`,
        });
        continue;
      }
      this.skillsByName.set(skill.name, skill);
    }

    for (const server of plugin.mcpServers) {
      if (this.serversByName.has(server.name)) {
        plugin.diagnostics.push({
          code: 'mcp_server_invalid',
          severity: 'warning',
          message: `MCP server "${server.name}" is already provided by another plugin and was skipped`,
          location: `${plugin.manifest.name}/mcp.json`,
        });
        continue;
      }
      this.serversByName.set(server.name, server.options);
    }

    this.plugins.push(plugin);
  }

  addRejection(diagnostics: PluginDiagnostic[]): void {
    this.rejections.push(...diagnostics);
  }

  getDirectory(): string | null {
    return this.directory;
  }

  list(): LoadedPlugin[] {
    return this.plugins;
  }

  skills(): DeploymentSkill[] {
    return Array.from(this.skillsByName.values());
  }

  /** Plugin MCP servers keyed by server name, shaped for `appConfig.mcpConfig`. */
  mcpServers(): Record<string, MCPOptions> {
    return Object.fromEntries(this.serversByName);
  }

  diagnostics(): PluginDiagnostic[] {
    return [...this.rejections, ...this.plugins.flatMap((plugin) => plugin.diagnostics)];
  }
}

let registry = new DeploymentPluginRegistry(null, []);

export function getDeploymentPluginRegistry(): DeploymentPluginRegistry {
  return registry;
}

export function getDeploymentPluginSkills(): DeploymentSkill[] {
  return registry.skills();
}

export function getDeploymentPluginMcpServers(): Record<string, MCPOptions> {
  return registry.mcpServers();
}

/**
 * Scans a directory of Agent Plugins packages. Each immediate child directory
 * is one plugin; a rejected plugin is reported and skipped so the remaining
 * packages still load.
 */
export async function loadPluginsFromDirectory(
  directory: string,
  options: DeploymentPluginOptions & { explicitlyConfigured?: boolean } = {},
): Promise<DeploymentPluginRegistry> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'ENOENT' &&
      options.explicitlyConfigured !== true
    ) {
      return new DeploymentPluginRegistry(directory, []);
    }
    throw new Error(`Deployment plugins directory could not be read: ${directory}`);
  }

  const dataRoot = resolveDeploymentPluginDataDirectory(options);
  await fs.promises.mkdir(dataRoot, { recursive: true });

  const candidates = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => path.join(directory, entry.name))
    .sort();

  const results = await Promise.all(
    candidates.map((candidate) =>
      loadPlugin(candidate, {
        dataRoot,
        ...(options.hookCapabilities !== undefined && {
          hookCapabilities: options.hookCapabilities,
        }),
      }),
    ),
  );

  const loaded: LoadedPlugin[] = [];
  const rejections: PluginDiagnostic[] = [];
  for (const result of results) {
    if (result.status === 'loaded') {
      loaded.push(result.plugin);
      continue;
    }
    /**
     * A rejected package has no manifest name to identify it, so its directory
     * is the only thing that tells an operator which one to fix.
     */
    for (const diagnostic of result.diagnostics) {
      rejections.push({
        ...diagnostic,
        location:
          diagnostic.location === undefined ? result.root : `${result.root}/${diagnostic.location}`,
      });
    }
  }

  const nextRegistry = new DeploymentPluginRegistry(directory, loaded);
  nextRegistry.addRejection(rejections);
  return nextRegistry;
}

function reportDiagnostics(current: DeploymentPluginRegistry): void {
  for (const diagnostic of current.diagnostics()) {
    const location = diagnostic.location === undefined ? '' : ` (${diagnostic.location})`;
    const message = `[agentPlugins] ${diagnostic.message}${location}`;
    if (diagnostic.severity === 'error') {
      logger.error(message);
      continue;
    }
    logger.warn(message);
  }
}

export async function initializeDeploymentPlugins(
  options: DeploymentPluginOptions = {},
): Promise<DeploymentPluginRegistry> {
  const resolved = resolveDeploymentPluginDirectory(options);
  registry = await loadPluginsFromDirectory(resolved.directory, {
    ...options,
    explicitlyConfigured: resolved.explicitlyConfigured,
  });
  reportDiagnostics(registry);

  const count = registry.list().length;
  if (count === 0) {
    logger.debug(`[agentPlugins] No plugins loaded from ${resolved.directory}`);
    return registry;
  }

  const skillCount = registry.skills().length;
  const serverCount = Object.keys(registry.mcpServers()).length;
  logger.info(
    `[agentPlugins] Loaded ${count} plugin(s) from ${resolved.directory}: ${skillCount} skill(s), ${serverCount} MCP server(s)`,
  );
  return registry;
}
