import type { SkillSyncGitHubSourceConfig } from 'librechat-data-provider';
import type { RepoCommit } from './types';
import { createGitHubRepoAdapter } from './github';

function response(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const normalizedHeaders = new Map(
    Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (key: string) => normalizedHeaders.get(key.toLowerCase()) ?? null,
    },
    json: async () => body,
  } as unknown as Response;
}

function treeEntry(overrides: Record<string, unknown> = {}) {
  return {
    path: 'SKILL.md',
    mode: '100644',
    type: 'blob',
    sha: 'blob-sha',
    size: 12,
    url: 'https://api.github.test/blob',
    ...overrides,
  };
}

function createSource(
  overrides: Partial<SkillSyncGitHubSourceConfig> = {},
): SkillSyncGitHubSourceConfig {
  return {
    id: 'librechat-skills',
    owner: 'LibreChat',
    repo: 'skills',
    ref: 'main',
    paths: ['skills'],
    credentialKey: 'github-skills-prod',
    ...overrides,
  };
}

function createAdapter(fetchFn: typeof fetch, source = createSource()) {
  return createGitHubRepoAdapter({ source, token: 'github_pat_secret', fetchFn });
}

const commit: RepoCommit = { id: 'commit-sha', treeId: 'tree-sha' };

describe('createGitHubRepoAdapter', () => {
  describe('resolveCommit', () => {
    it('resolves the configured ref to its commit and root tree', async () => {
      const fetchFn = jest.fn(async () =>
        response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } }),
      ) as unknown as typeof fetch;

      await expect(createAdapter(fetchFn).resolveCommit()).resolves.toEqual({
        id: 'commit-sha',
        treeId: 'tree-sha',
      });
      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.github.com/repos/LibreChat/skills/commits/main',
        {
          headers: expect.objectContaining({
            Accept: 'application/vnd.github+json',
            Authorization: 'Bearer github_pat_secret',
            'X-GitHub-Api-Version': '2022-11-28',
            'User-Agent': 'LibreChat-Skill-Sync',
          }),
        },
      );
    });

    it('encodes each ref segment without escaping its separators', async () => {
      const fetchFn = jest.fn(async () =>
        response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } }),
      ) as unknown as typeof fetch;

      await createAdapter(fetchFn, createSource({ ref: 'release/v1 rc' })).resolveCommit();

      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.github.com/repos/LibreChat/skills/commits/release/v1%20rc',
        expect.anything(),
      );
    });
  });

  describe('fetchTreeEntries', () => {
    it('lists the whole repository from the root tree when no path is configured', async () => {
      const fetchFn = jest.fn(async () =>
        response({ sha: 'tree-sha', truncated: false, tree: [treeEntry()] }),
      ) as unknown as typeof fetch;

      const entries = await createAdapter(fetchFn).fetchTreeEntries(commit, {
        pathPrefix: '',
        assertNotCancelled: () => undefined,
      });

      expect(entries).toEqual([{ path: 'SKILL.md', type: 'blob', id: 'blob-sha', size: 12 }]);
      expect(fetchFn).toHaveBeenCalledTimes(1);
      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.github.com/repos/LibreChat/skills/git/trees/tree-sha?recursive=1',
        expect.anything(),
      );
    });

    it('walks one non-recursive listing per path segment before listing recursively', async () => {
      const fetchFn = jest.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes('/git/trees/tree-sha')) {
          return response({
            sha: 'tree-sha',
            truncated: false,
            tree: [treeEntry({ path: 'skills', type: 'tree', sha: 'skills-tree-sha' })],
          });
        }
        if (url.includes('/git/trees/skills-tree-sha')) {
          return response({
            sha: 'skills-tree-sha',
            truncated: false,
            tree: [treeEntry({ path: 'shared', type: 'tree', sha: 'shared-tree-sha' })],
          });
        }
        return response({
          sha: 'shared-tree-sha',
          truncated: false,
          tree: [treeEntry({ path: 'research/SKILL.md', sha: 'skill-md-sha' })],
        });
      }) as unknown as typeof fetch;

      const entries = await createAdapter(fetchFn).fetchTreeEntries(commit, {
        pathPrefix: 'skills/shared',
        assertNotCancelled: () => undefined,
      });

      expect(entries).toEqual([
        { path: 'skills/shared/research/SKILL.md', type: 'blob', id: 'skill-md-sha', size: 12 },
      ]);
      const urls = (fetchFn as unknown as jest.Mock).mock.calls.map(([input]) => String(input));
      expect(urls).toEqual([
        'https://api.github.com/repos/LibreChat/skills/git/trees/tree-sha',
        'https://api.github.com/repos/LibreChat/skills/git/trees/skills-tree-sha',
        'https://api.github.com/repos/LibreChat/skills/git/trees/shared-tree-sha?recursive=1',
      ]);
    });

    it('reports a configured path that no tree segment matches', async () => {
      const fetchFn = jest.fn(async () =>
        response({ sha: 'tree-sha', truncated: false, tree: [treeEntry()] }),
      ) as unknown as typeof fetch;

      await expect(
        createAdapter(fetchFn).fetchTreeEntries(commit, {
          pathPrefix: 'skills',
          assertNotCancelled: () => undefined,
        }),
      ).rejects.toMatchObject({ name: 'SkillSyncError', code: 'GITHUB_PATH_NOT_FOUND' });
    });

    it('refuses a truncated listing rather than syncing a partial repository', async () => {
      const fetchFn = jest.fn(async () =>
        response({ sha: 'tree-sha', truncated: true, tree: [treeEntry()] }),
      ) as unknown as typeof fetch;

      await expect(
        createAdapter(fetchFn).fetchTreeEntries(commit, {
          pathPrefix: '',
          assertNotCancelled: () => undefined,
        }),
      ).rejects.toMatchObject({ name: 'SkillSyncError', code: 'GITHUB_TREE_TRUNCATED' });
    });

    it('reports submodule entries as neither files nor directories', async () => {
      const fetchFn = jest.fn(async () =>
        response({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            treeEntry({ path: 'vendor', type: 'commit', sha: 'submodule-sha', size: undefined }),
            treeEntry({ path: 'skills', type: 'tree', sha: 'dir-sha', size: undefined }),
          ],
        }),
      ) as unknown as typeof fetch;

      const entries = await createAdapter(fetchFn).fetchTreeEntries(commit, {
        pathPrefix: '',
        assertNotCancelled: () => undefined,
      });

      expect(entries.map((entry) => entry.type)).toEqual(['submodule', 'tree']);
    });

    it('checks for cancellation between round trips', async () => {
      const fetchFn = jest.fn(async (input: RequestInfo | URL) =>
        String(input).includes('recursive=1')
          ? response({ sha: 'skills-tree-sha', truncated: false, tree: [treeEntry()] })
          : response({
              sha: 'tree-sha',
              truncated: false,
              tree: [treeEntry({ path: 'skills', type: 'tree', sha: 'skills-tree-sha' })],
            }),
      ) as unknown as typeof fetch;
      const assertNotCancelled = jest.fn();

      await createAdapter(fetchFn).fetchTreeEntries(commit, {
        pathPrefix: 'skills',
        assertNotCancelled,
      });

      expect(assertNotCancelled.mock.calls.length).toBeGreaterThanOrEqual(4);
    });

    it('stops listing as soon as cancellation is signalled', async () => {
      const fetchFn = jest.fn(async () =>
        response({
          sha: 'tree-sha',
          truncated: false,
          tree: [treeEntry({ path: 'skills', type: 'tree', sha: 'skills-tree-sha' })],
        }),
      ) as unknown as typeof fetch;

      await expect(
        createAdapter(fetchFn).fetchTreeEntries(commit, {
          pathPrefix: 'skills',
          assertNotCancelled: () => {
            throw new Error('cancelled');
          },
        }),
      ).rejects.toThrow('cancelled');
      expect(fetchFn).not.toHaveBeenCalled();
    });
  });

  describe('fetchFileContent', () => {
    it('decodes base64 blob content, ignoring the wrapping whitespace GitHub inserts', async () => {
      const fetchFn = jest.fn(async () =>
        response({
          sha: 'blob-sha',
          encoding: 'base64',
          size: 5,
          content: `${Buffer.from('hello').toString('base64')}\n`,
        }),
      ) as unknown as typeof fetch;

      const buffer = await createAdapter(fetchFn).fetchFileContent(commit, {
        path: 'skills/research/SKILL.md',
        type: 'blob',
        id: 'skill-md-sha',
      });

      expect(buffer.toString('utf-8')).toBe('hello');
      expect(fetchFn).toHaveBeenCalledWith(
        'https://api.github.com/repos/LibreChat/skills/git/blobs/skill-md-sha',
        expect.anything(),
      );
    });

    it('refuses a blob encoding it cannot decode', async () => {
      const fetchFn = jest.fn(async () =>
        response({ sha: 'blob-sha', encoding: 'utf-8', size: 5, content: 'hello' }),
      ) as unknown as typeof fetch;

      await expect(
        createAdapter(fetchFn).fetchFileContent(commit, {
          path: 'skills/research/SKILL.md',
          type: 'blob',
          id: 'skill-md-sha',
        }),
      ).rejects.toMatchObject({ name: 'SkillSyncError', code: 'GITHUB_UNSUPPORTED_BLOB' });
    });
  });

  describe('error classification', () => {
    it.each([
      {
        label: 'an exhausted rate limit budget',
        status: 403,
        headers: { 'x-ratelimit-remaining': '0' },
        code: 'GITHUB_RATE_LIMITED',
      },
      {
        label: 'a retry-after directive',
        status: 403,
        headers: { 'retry-after': '60' },
        code: 'GITHUB_RATE_LIMITED',
      },
      {
        label: 'an explicit rate limit status',
        status: 429,
        headers: {},
        code: 'GITHUB_RATE_LIMITED',
      },
      { label: 'a rejected credential', status: 401, headers: {}, code: 'GITHUB_AUTH_FAILED' },
      { label: 'a forbidden repository', status: 403, headers: {}, code: 'GITHUB_AUTH_FAILED' },
      { label: 'a missing repository', status: 404, headers: {}, code: 'GITHUB_NOT_FOUND' },
      { label: 'an upstream outage', status: 500, headers: {}, code: 'GITHUB_REQUEST_FAILED' },
    ])('maps $label to $code', async ({ status, headers, code }) => {
      const fetchFn = jest.fn(async () =>
        response({ message: 'nope' }, status, headers as Record<string, string>),
      ) as unknown as typeof fetch;

      await expect(createAdapter(fetchFn).resolveCommit()).rejects.toMatchObject({
        name: 'SkillSyncError',
        code,
      });
    });

    it('treats a rate limit explained only in the body as a rate limit', async () => {
      const fetchFn = jest.fn(async () =>
        response({ message: 'You have exceeded a secondary rate limit' }, 403),
      ) as unknown as typeof fetch;

      await expect(createAdapter(fetchFn).resolveCommit()).rejects.toMatchObject({
        name: 'SkillSyncError',
        code: 'GITHUB_RATE_LIMITED',
      });
    });

    it('reports a transport failure without leaking the underlying error', async () => {
      const fetchFn = jest.fn(async () => {
        throw new Error('ECONNREFUSED 140.82.121.6:443');
      }) as unknown as typeof fetch;

      await expect(createAdapter(fetchFn).resolveCommit()).rejects.toMatchObject({
        name: 'SkillSyncError',
        code: 'GITHUB_REQUEST_FAILED',
        message: expect.not.stringContaining('ECONNREFUSED'),
      });
    });
  });
});
