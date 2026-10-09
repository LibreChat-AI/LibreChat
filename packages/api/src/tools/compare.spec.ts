import { Agent } from 'undici';
import { GitHubCompareTool, GitHubCompareToolDefinition } from '@librechat/agents';
import type { TPlugin } from 'librechat-data-provider';
import {
  createGitHubCompareTool,
  createGitHubCompareRegistry,
  filterGitHubComparePlugins,
  getGitHubCompareCatalogTools,
} from './compare';
import { registerCodeExecutionTools } from '../agents/tools';

const config = { enabled: true, timeoutMs: 2000 };
const base = 'a'.repeat(40);
const head = 'b'.repeat(40);
const input = { owner: 'LibreChat-AI', repo: 'agents', base, head };
const body = {
  base_commit: { sha: base },
  merge_base_commit: { sha: base },
  status: 'ahead',
  ahead_by: 1,
  behind_by: 0,
  total_commits: 1,
};
const mockFetch = (
  implementation: (...args: Parameters<typeof globalThis.fetch>) => Promise<Response> = async () =>
    new Response(JSON.stringify(body)),
) => Object.assign(jest.fn(implementation), { preconnect: jest.fn() });
const registry = () => createGitHubCompareRegistry(['github_compare'], config);

it.each([undefined, {}, { enabled: false }])(
  'does not initialize transport for disabled policy %p',
  (config) => {
    const fetch = mockFetch();
    const getDispatcher = jest.fn();
    expect(
      createGitHubCompareTool({ config, toolRegistry: registry(), fetch, getDispatcher }),
    ).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(getDispatcher).not.toHaveBeenCalled();
  },
);

it.each([undefined, new Map()])(
  'denies model-emitted unregistered comparison (%p)',
  (toolRegistry) => {
    const fetch = mockFetch();
    const getDispatcher = jest.fn();
    expect(createGitHubCompareTool({ config, toolRegistry, fetch, getDispatcher })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(getDispatcher).not.toHaveBeenCalled();
  },
);

it('uses the published callable SDK with the caller-owned proxy transport', async () => {
  const dispatcher = new Agent();
  const fetch = mockFetch(async () => new Response(JSON.stringify(body)));
  const getDispatcher = jest.fn(() => dispatcher);
  const tool = createGitHubCompareTool({ config, toolRegistry: registry(), fetch, getDispatcher });
  expect(tool).toBeInstanceOf(GitHubCompareTool);
  expect(tool?.description).toBe(GitHubCompareToolDefinition.description);
  expect(await tool?.invoke(input)).toBe(
    JSON.stringify({
      base,
      head,
      mergeBase: base,
      status: 'ahead',
      aheadBy: 1,
      behindBy: 0,
      totalCommits: 1,
    }),
  );
  expect(getDispatcher).toHaveBeenCalledTimes(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(fetch.mock.calls[0]).toEqual([
    `https://api.github.com/repos/LibreChat-AI/agents/compare/${base}...${head}?per_page=1&page=2`,
    expect.objectContaining({
      dispatcher,
      redirect: 'error',
      credentials: 'omit',
      signal: expect.any(AbortSignal),
    }),
  ]);
});

it('retains SDK operational failure semantics without exposing upstream bodies', async () => {
  const fetch = mockFetch(async () => new Response('secret response', { status: 429 }));
  const tool = createGitHubCompareTool({
    config,
    toolRegistry: registry(),
    fetch,
    getDispatcher: () => undefined,
  });
  await expect(tool?.invoke(input)).rejects.toMatchObject({ code: 'HTTP_ERROR', status: 429 });
});

it('retains the run cancellation signal through the host transport', async () => {
  const abort = new AbortController();
  const fetch = mockFetch(async () => {
    abort.abort();
    return new Response(JSON.stringify(body));
  });
  const tool = createGitHubCompareTool({
    config,
    toolRegistry: registry(),
    fetch,
    getDispatcher: () => undefined,
  });
  await expect(tool?.invoke(input, { signal: abort.signal })).rejects.toMatchObject({
    name: 'AbortError',
  });
});

it('uses the configured SDK request deadline', async () => {
  jest.useFakeTimers();
  try {
    const fetch = mockFetch(() => new Promise<Response>(() => undefined));
    const tool = createGitHubCompareTool({
      config,
      toolRegistry: registry(),
      fetch,
      getDispatcher: () => undefined,
    });
    const rejected = (async () => {
      await expect(tool?.invoke(input)).rejects.toMatchObject({ name: 'TimeoutError' });
    })();
    await jest.advanceTimersByTimeAsync(2000);
    await rejected;
  } finally {
    jest.useRealTimers();
  }
});

it('requires explicit selection even when the deployment enables comparison', () => {
  expect(createGitHubCompareRegistry(['calculator'], config).size).toBe(0);
  expect(createGitHubCompareRegistry(['github_compare'], undefined).size).toBe(0);
  expect(registry().get('github_compare')).toEqual(GitHubCompareToolDefinition);
});

it('does not attach comparison to workspace or code execution capabilities', () => {
  const definitions = registerCodeExecutionTools({
    toolRegistry: new Map(),
    toolDefinitions: [],
    includeBash: true,
    workspaceTools: true,
    workspaceOperations: new Set(['execute_command']),
    workspaceEnvironment: {
      fingerprint: 'a'.repeat(64),
      repo: 'LibreChat-AI/LibreChat',
      ref: 'dev',
      actions: [],
    },
  });
  expect(definitions.toolNames).not.toContain('github_compare');
});

it('hides stale comparison catalog entries when the request disables the integration', () => {
  const plugins: TPlugin[] = [
    { name: 'GitHub Compare', pluginKey: 'github_compare', description: 'compare' },
    { name: 'Calculator', pluginKey: 'calculator', description: 'calculate' },
  ];
  expect(filterGitHubComparePlugins(plugins, config)).toBe(plugins);
  expect(filterGitHubComparePlugins(plugins, undefined).map(({ pluginKey }) => pluginKey)).toEqual([
    'calculator',
  ]);
});

it('keeps catalog metadata inert and honors the existing include/filter precedence', () => {
  expect(getGitHubCompareCatalogTools([], [])[0].function).toBe(GitHubCompareToolDefinition);
  expect(getGitHubCompareCatalogTools(['calculator'], [])).toEqual([]);
  expect(getGitHubCompareCatalogTools([], ['github_compare'])).toEqual([]);
  expect(getGitHubCompareCatalogTools(['github_compare'], ['github_compare'])).toHaveLength(1);
});
