import {
  GitHubCompareTool,
  GitHubCompareToolName,
  GitHubCompareToolDefinition,
} from '@librechat/agents';
import type { TCustomConfig, TPlugin } from 'librechat-data-provider';
import type { LCToolRegistry } from '@librechat/agents';
import type { Dispatcher } from 'undici';

type GitHubCompareConfig = TCustomConfig['githubCompare'];

/** Build a registry only for the legacy initialization path, never for execution. */
export function createGitHubCompareRegistry(
  tools: readonly string[] | undefined,
  config: GitHubCompareConfig,
): LCToolRegistry {
  return new Map(
    config?.enabled === true && tools?.includes(GitHubCompareToolName) === true
      ? [
          [
            GitHubCompareToolName,
            {
              ...GitHubCompareToolDefinition,
              parameters: {
                ...GitHubCompareToolDefinition.parameters,
                required: [...GitHubCompareToolDefinition.parameters.required],
              },
            },
          ],
        ]
      : [],
  );
}

export function createGitHubCompareTool({
  config,
  toolRegistry,
  fetch,
  getDispatcher,
}: {
  config: GitHubCompareConfig;
  toolRegistry: LCToolRegistry | undefined;
  fetch: typeof globalThis.fetch;
  getDispatcher: () => Dispatcher | undefined;
}): GitHubCompareTool | null {
  if (config?.enabled !== true || toolRegistry?.has(GitHubCompareToolName) !== true) {
    return null;
  }
  const dispatcher = getDispatcher();
  const transport = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const request: RequestInit & { dispatcher?: Dispatcher } = { ...init, dispatcher };
      return fetch(input, request);
    },
    fetch,
  );
  return new GitHubCompareTool({ fetch: transport, timeoutMs: config.timeoutMs });
}

export function filterGitHubComparePlugins(
  plugins: TPlugin[],
  config: GitHubCompareConfig,
): TPlugin[] {
  return config?.enabled === true
    ? plugins
    : plugins.filter(({ pluginKey }) => pluginKey !== GitHubCompareToolName);
}

/** Catalog metadata is inert; visibility and execution consult the current request's config. */
export function getGitHubCompareCatalogTools(
  included: string[],
  filtered: string[],
): Array<{ type: 'function'; function: typeof GitHubCompareToolDefinition }> {
  if (
    included.length > 0
      ? !included.includes(GitHubCompareToolName)
      : filtered.includes(GitHubCompareToolName)
  ) {
    return [];
  }
  return [{ type: 'function' as const, function: GitHubCompareToolDefinition }];
}
