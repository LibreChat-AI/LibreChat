import type { TCustomConfig, TPlugin } from 'librechat-data-provider';
import { checkPluginAuth, filterUniquePlugins, getToolkitKey } from './format';
import { filterGitHubComparePlugins } from './compare';

/** A tool manifest entry: a plugin, and whether only the agents runtime can run it. */
export type ManifestTool = TPlugin & { agentsOnly?: boolean };

export interface ListAvailableToolsParams {
  /** The tool manifest (`api/app/clients/tools/manifest.json`). */
  manifest: ManifestTool[];
  /** The manifest entries that are toolkits, whose tools are defined under prefixed names. */
  toolkits: TPlugin[];
  /** The tool definitions the server loaded, by name (the tool cache). */
  toolDefinitions: Record<string, unknown> | null | undefined;
  /** The requester's `githubCompare` config: the compare tool is listed only when enabled. */
  githubCompare?: TCustomConfig['githubCompare'];
  /**
   * Leaves out the tools only the agents runtime can run (`agentsOnly`, such as
   * `ask_user_question`), for the Assistants tool dialog.
   */
  forAssistants?: boolean;
}

/**
 * The manifest tools a server offers: each unique manifest entry the loaded definitions define,
 * by its own key or (a toolkit) through a tool under its prefix, marked `authenticated` when the
 * server holds every credential it needs. This is what `GET /api/agents/tools` lists.
 */
export function listAvailableTools({
  manifest,
  toolkits,
  toolDefinitions,
  githubCompare,
  forAssistants = false,
}: ListAvailableToolsParams): ManifestTool[] {
  const plugins: ManifestTool[] = filterUniquePlugins(
    filterGitHubComparePlugins(manifest, githubCompare),
  );
  const definedKeys = toolDefinitions ? Object.keys(toolDefinitions) : null;
  const defined = definedKeys ? new Set(definedKeys) : null;
  const tools: ManifestTool[] = [];
  for (const plugin of plugins) {
    if (plugin.agentsOnly === true && forAssistants) {
      continue;
    }
    const isDefined = defined?.has(plugin.pluginKey) === true;
    const isToolkit =
      plugin.toolkit === true &&
      definedKeys != null &&
      definedKeys.some((key) => getToolkitKey({ toolkits, toolName: key }) === plugin.pluginKey);
    if (!isDefined && !isToolkit) {
      continue;
    }
    tools.push(checkPluginAuth(plugin) ? { ...plugin, authenticated: true } : plugin);
  }
  return tools;
}
