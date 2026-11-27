import fs from 'fs';
import path from 'path';
import type { PluginDiagnostic, PluginLoadResult, PluginManifest } from './types';
import type { PluginHookCapabilities } from '~/agents/hooks';
import type { PluginHooksResult } from './hooks';
import { realpathAllowingMissing, resolveWithinRoot } from './paths';
import { PLUGIN_MANIFEST_FILE, PLUGIN_MCP_FILE } from './constants';
import { loadPluginHooks, reportUnexecutedHooks } from './hooks';
import { readMcpConfig, schemaVersion } from './mcp';
import { validateManifest } from './manifest';
import { loadPluginSkills } from './skills';

export interface LoadPluginOptions {
  /** Root under which each plugin's persistent `PLUGIN_DATA` directory is created. */
  dataRoot: string;
  hookCapabilities?: PluginHookCapabilities;
}

function rejected(root: string, diagnostics: PluginDiagnostic[]): PluginLoadResult {
  return { status: 'rejected', root, diagnostics };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function readMcpDocument(
  realRoot: string,
): Promise<{ document?: unknown; diagnostics: PluginDiagnostic[] }> {
  const mcpPath = await resolveWithinRoot(realRoot, PLUGIN_MCP_FILE);
  if (mcpPath === null) {
    return {
      diagnostics: [
        {
          code: 'path_escape',
          severity: 'warning',
          message: 'mcp.json resolves outside the plugin root; MCP was disabled for this plugin',
          location: PLUGIN_MCP_FILE,
        },
      ],
    };
  }

  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(mcpPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { diagnostics: [] };
    }
    return {
      diagnostics: [
        {
          code: 'mcp_unreadable',
          severity: 'warning',
          message: `mcp.json could not be read: ${errorMessage(error)}`,
          location: PLUGIN_MCP_FILE,
        },
      ],
    };
  }
  if (!stat.isFile()) {
    return {
      diagnostics: [
        {
          code: 'component_location_invalid',
          severity: 'warning',
          message: 'mcp.json is not a regular file; MCP was disabled for this plugin',
          location: PLUGIN_MCP_FILE,
        },
      ],
    };
  }

  try {
    return { document: JSON.parse(await fs.promises.readFile(mcpPath, 'utf8')), diagnostics: [] };
  } catch (error) {
    return {
      diagnostics: [
        {
          code: 'mcp_invalid_json',
          severity: 'warning',
          message: `mcp.json is not valid JSON: ${errorMessage(error)}`,
          location: PLUGIN_MCP_FILE,
        },
      ],
    };
  }
}

async function readManifest(
  realRoot: string,
): Promise<{ manifest?: PluginManifest; diagnostics: PluginDiagnostic[] }> {
  const manifestPath = await resolveWithinRoot(realRoot, PLUGIN_MANIFEST_FILE);
  if (manifestPath === null) {
    return {
      diagnostics: [
        {
          code: 'path_escape',
          severity: 'error',
          message: 'plugin.json resolves outside the plugin root',
          location: PLUGIN_MANIFEST_FILE,
        },
      ],
    };
  }

  let raw: string;
  try {
    raw = await fs.promises.readFile(manifestPath, 'utf8');
  } catch (error) {
    const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
    return {
      diagnostics: [
        {
          code: missing ? 'manifest_missing' : 'manifest_unreadable',
          severity: 'error',
          message: missing
            ? 'plugin.json was not found in the plugin root'
            : `plugin.json could not be read: ${errorMessage(error)}`,
          location: PLUGIN_MANIFEST_FILE,
        },
      ],
    };
  }

  let document: unknown;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    return {
      diagnostics: [
        {
          code: 'manifest_invalid_json',
          severity: 'error',
          message: `plugin.json is not valid JSON: ${errorMessage(error)}`,
          location: PLUGIN_MANIFEST_FILE,
        },
      ],
    };
  }

  const result = validateManifest(document);
  if (result.status === 'rejected') {
    return { diagnostics: result.diagnostics };
  }
  return { manifest: result.manifest, diagnostics: result.diagnostics };
}

/**
 * Loads one Agent Plugins package. A manifest failure rejects the plugin;
 * every component failure below it is isolated so independently valid
 * components still load (§11.3).
 */
export async function loadPlugin(
  root: string,
  options: LoadPluginOptions,
): Promise<PluginLoadResult> {
  const realRoot = await realpathAllowingMissing(root);
  const { manifest, diagnostics: manifestDiagnostics } = await readManifest(realRoot);
  if (manifest === undefined) {
    return rejected(realRoot, manifestDiagnostics);
  }

  const diagnostics: PluginDiagnostic[] = [...manifestDiagnostics];
  const dataDirectory = path.join(options.dataRoot, manifest.name);
  try {
    await fs.promises.mkdir(dataDirectory, { recursive: true });
  } catch (error) {
    return rejected(realRoot, [
      ...diagnostics,
      {
        code: 'data_directory_unavailable',
        severity: 'error',
        message: `The persistent data directory could not be created: ${errorMessage(error)}`,
        location: dataDirectory,
      },
    ]);
  }
  const realDataDirectory = await realpathAllowingMissing(dataDirectory);

  const [skillsResult, mcpDocument, hooksResult] = await Promise.all([
    loadPluginSkills(realRoot, manifest.name),
    readMcpDocument(realRoot),
    options.hookCapabilities === undefined
      ? reportUnexecutedHooks(realRoot).then<PluginHooksResult>((diagnostics) => ({ diagnostics }))
      : loadPluginHooks(realRoot, options.hookCapabilities),
  ]);

  diagnostics.push(
    ...skillsResult.diagnostics,
    ...mcpDocument.diagnostics,
    ...hooksResult.diagnostics,
  );

  const mcpResult =
    mcpDocument.document === undefined
      ? { servers: [], diagnostics: [] }
      : await readMcpConfig(mcpDocument.document, {
          realRoot,
          dataDirectory: realDataDirectory,
          declaredVersion: schemaVersion(manifest.$schema) ?? '',
        });
  diagnostics.push(...mcpResult.diagnostics);

  return {
    status: 'loaded',
    plugin: {
      root: realRoot,
      dataDirectory: realDataDirectory,
      manifest,
      skills: skillsResult.skills,
      mcpServers: mcpResult.servers,
      ...(hooksResult.hooks !== undefined && { hooks: hooksResult.hooks }),
      diagnostics,
    },
  };
}
