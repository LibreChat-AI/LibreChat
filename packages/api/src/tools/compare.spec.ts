import { compareGitHubCommits, GitHubCompareTool } from './compare';
import { registerCodeExecutionTools } from '../agents/tools';
const base = 'a'.repeat(40),
  head = 'b'.repeat(40),
  merge = 'c'.repeat(40);
const input = { owner: 'LibreChat-AI', repo: 'LibreChat', base, head };
const response = () =>
  new Response(
    JSON.stringify({
      base_commit: { sha: base },
      merge_base_commit: { sha: merge },
      status: 'diverged',
      ahead_by: 2,
      behind_by: 3,
      total_commits: 2,
    }),
  );
test('returns the frozen merge-base through one read-only GitHub request', async () => {
  const fetchImpl = jest.fn().mockResolvedValue(response());
  expect(await compareGitHubCommits(input, fetchImpl)).toEqual({
    base,
    head,
    mergeBase: merge,
    status: 'diverged',
    aheadBy: 2,
    behindBy: 3,
    totalCommits: 2,
  });
  expect(fetchImpl.mock.calls[0][0]).toBe(
    `https://api.github.com/repos/LibreChat-AI/LibreChat/compare/${base}...${head}?per_page=1`,
  );
  expect(fetchImpl.mock.calls[0][1]).toMatchObject({ method: 'GET', redirect: 'error' });
  expect(fetchImpl.mock.calls[0][1].headers.Authorization).toBeUndefined();
});
test.each(['../private', 'https://evil.test', 'repo?token=x', '--base'])(
  'rejects caller-controlled routes (%s)',
  async (repo) => {
    const fetchImpl = jest.fn();
    await expect(compareGitHubCommits({ ...input, repo }, fetchImpl)).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  },
);
test('rejects moving refs and malformed merge-bases', async () => {
  await expect(compareGitHubCommits({ ...input, base: 'dev' })).rejects.toThrow();
  await expect(
    compareGitHubCommits(input, jest.fn().mockResolvedValue(new Response('{"status":"ahead"}'))),
  ).rejects.toThrow();
});
test('does not expose provider bodies on failure', async () => {
  await expect(
    compareGitHubCommits(
      input,
      jest.fn().mockResolvedValue(new Response('secret', { status: 403 })),
    ),
  ).rejects.toThrow('HTTP 403');
});

test('comparison cannot fetch moving or credential-bearing repository references', async () => {
  const fetchImpl = jest.fn();
  await expect(compareGitHubCommits({ ...input, owner: 'user@host' }, fetchImpl)).rejects.toThrow();
  await expect(compareGitHubCommits({ ...input, head: 'HEAD' }, fetchImpl)).rejects.toThrow();
  expect(fetchImpl).not.toHaveBeenCalled();
});

test('attached command agents receive the read-only compare definition without worker transport', async () => {
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
  expect(definitions.toolNames).toContain('github_compare');
});

test('constructs the callable registered tool', () => {
  const compare = new GitHubCompareTool();
  expect(compare.name).toBe('github_compare');
});
