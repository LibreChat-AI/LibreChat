import crypto from 'crypto';
import { Types } from 'mongoose';
import { logger, getTenantId } from '@librechat/data-schemas';
import type {
  ISkill,
  ISkillFile,
  CreateSkillInput,
  CreateSkillResult,
  ISkillSyncStatus,
  SkillSyncStatusInput,
  UpdateSkillInput,
  UpdateSkillResult,
  UpsertSkillFileInput,
  DeleteSkillResult,
} from '@librechat/data-schemas';
import type { RepoTreeEntry, GitRepoAdapter } from './adapters/types';
import type { GitHubSkillSyncDeps } from './github';
import { DEFAULT_SKILL_IMPORT_LIMITS } from '../limits';
import { createGitHubSkillSyncRunner } from './github';

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

function blob(content: string) {
  return {
    sha: 'blob-sha',
    encoding: 'base64',
    size: Buffer.byteLength(content),
    content: Buffer.from(content).toString('base64'),
  };
}

function completeSkillDeletion(deleted: boolean): DeleteSkillResult {
  return {
    deleted,
    skillAbsent: true,
    cleanupComplete: true,
    failedCleanupSteps: [],
  };
}

function incompleteSkillDeletion(
  failedCleanupSteps: DeleteSkillResult['failedCleanupSteps'],
): DeleteSkillResult {
  return {
    deleted: true,
    skillAbsent: true,
    cleanupComplete: false,
    failedCleanupSteps,
  };
}

function githubFetch(
  skillMarkdown = '---\nname: research\ndescription: Research things\nalways-apply: true\n---\nBody',
): typeof fetch {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes('/commits/')) {
      return response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } });
    }
    if (url.includes('/git/trees/tree-sha')) {
      return response({
        sha: 'tree-sha',
        truncated: false,
        tree: [
          {
            path: 'skills',
            mode: '040000',
            type: 'tree',
            sha: 'skills-tree-sha',
            url: 'https://api.github.test/tree/skills',
          },
        ],
      });
    }
    if (url.includes('/git/trees/skills-tree-sha')) {
      return response({
        sha: 'skills-tree-sha',
        truncated: false,
        tree: [
          {
            path: 'research/SKILL.md',
            mode: '100644',
            type: 'blob',
            sha: 'skill-md-sha',
            size: Buffer.byteLength(skillMarkdown),
            url: 'https://api.github.test/blob/skill',
          },
          {
            path: 'research/scripts/run.sh',
            mode: '100644',
            type: 'blob',
            sha: 'file-sha',
            size: 7,
            url: 'https://api.github.test/blob/file',
          },
        ],
      });
    }
    if (url.includes('/git/blobs/skill-md-sha')) {
      return response(blob(skillMarkdown));
    }
    if (url.includes('/git/blobs/file-sha')) {
      return response(blob('echo ok'));
    }
    return response({ message: 'not found' }, 404);
  }) as unknown as typeof fetch;
}

/** Serves one `skills/<dir>/SKILL.md` per entry, in the order given. */
function multiSkillFetch(
  skills: Array<{ dir: string; markdown: string }>,
  {
    rateLimitedDirs = [],
    requestFailedDirs = [],
    rejectedDirs = [],
  }: {
    rateLimitedDirs?: string[];
    requestFailedDirs?: string[];
    rejectedDirs?: string[];
  } = {},
): typeof fetch {
  return jest.fn(async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.includes('/commits/')) {
      return response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } });
    }
    if (url.includes('/git/trees/tree-sha')) {
      return response({
        sha: 'tree-sha',
        truncated: false,
        tree: [
          {
            path: 'skills',
            mode: '040000',
            type: 'tree',
            sha: 'skills-tree-sha',
            url: 'https://api.github.test/tree/skills',
          },
        ],
      });
    }
    if (url.includes('/git/trees/skills-tree-sha')) {
      return response({
        sha: 'skills-tree-sha',
        truncated: false,
        tree: skills.map(({ dir, markdown }) => ({
          path: `${dir}/SKILL.md`,
          mode: '100644',
          type: 'blob',
          sha: `${dir}-skill-sha`,
          size: Buffer.byteLength(markdown),
          url: `https://api.github.test/blob/${dir}`,
        })),
      });
    }
    const requested = skills.find(({ dir }) => url.includes(`/git/blobs/${dir}-skill-sha`));
    if (requested && rateLimitedDirs.includes(requested.dir)) {
      return response({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
      });
    }
    if (requested && requestFailedDirs.includes(requested.dir)) {
      return response({ message: 'upstream unavailable' }, 503);
    }
    if (requested && rejectedDirs.includes(requested.dir)) {
      throw new TypeError('fetch failed');
    }
    if (requested) {
      return response(blob(requested.markdown));
    }
    return response({ message: 'not found' }, 404);
  }) as unknown as typeof fetch;
}

function makeSkill(input: CreateSkillInput): ISkill & { _id: Types.ObjectId } {
  return {
    _id: new Types.ObjectId(),
    name: input.name,
    description: input.description,
    body: input.body ?? '',
    frontmatter: input.frontmatter ?? {},
    author: input.author,
    authorName: input.authorName,
    version: 1,
    source: input.source ?? 'inline',
    sourceMetadata: input.sourceMetadata,
    fileCount: 0,
    alwaysApply: input.alwaysApply ?? false,
    tenantId: input.tenantId,
  };
}

function makeSkillFile(
  skill: ISkill & { _id: Types.ObjectId },
  overrides: Partial<ISkillFile> = {},
): ISkillFile & { _id: Types.ObjectId } {
  return {
    _id: new Types.ObjectId(),
    skillId: skill._id,
    relativePath: 'scripts/run.sh',
    file_id: 'old-file-id',
    filename: 'run.sh',
    filepath: '/uploads/old-file-id__run.sh',
    source: 'local',
    sourceMetadata: {
      provider: 'github',
      sourceId: 'librechat-skills',
      upstreamId: 'librechat-skills:skills/research',
      commitSha: 'old-commit-sha',
      blobSha: 'old-file-sha',
      path: 'skills/research/scripts/run.sh',
    },
    mimeType: 'application/x-sh',
    bytes: 7,
    category: 'script',
    isExecutable: false,
    author: skill.author,
    ...overrides,
  };
}

function makeSourceAuthorId(sourceId = 'librechat-skills', tenantId?: string): Types.ObjectId {
  const seed = tenantId ? `github:${sourceId}:${tenantId}` : `github:${sourceId}`;
  return new Types.ObjectId(crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24));
}

function createDeps(
  overrides: Partial<GitHubSkillSyncDeps> = {},
): GitHubSkillSyncDeps & { statuses: ISkillSyncStatus[] } {
  const statuses: ISkillSyncStatus[] = [];
  const deps: GitHubSkillSyncDeps & { statuses: ISkillSyncStatus[] } = {
    statuses,
    getConfig: () => ({
      github: {
        enabled: true,
        intervalMinutes: 60,
        runOnStartup: false,
        sources: [
          {
            id: 'librechat-skills',
            owner: 'LibreChat',
            repo: 'skills',
            ref: 'main',
            paths: ['skills'],
            credentialKey: 'github-skills-prod',
          },
        ],
      },
    }),
    getCredentialToken: jest.fn(async () => 'github_pat_secret'),
    getCredentialSummary: jest.fn(async () => ({
      provider: 'github' as const,
      credentialKey: 'github-skills-prod',
      credentialPresent: true,
      tokenFingerprint: 'abc123',
    })),
    listCredentials: jest.fn(async () => []),
    listStatuses: jest.fn(async () => statuses),
    upsertStatus: jest.fn(async (input: SkillSyncStatusInput) => {
      const status: ISkillSyncStatus = {
        provider: input.provider,
        sourceId: input.sourceId,
        tenantId: input.tenantId,
        status: input.status,
        credentialKey: input.credentialKey,
        owner: input.owner,
        repo: input.repo,
        ref: input.ref,
        paths: input.paths,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        lastSuccessAt:
          input.status === 'succeeded' || input.status === 'partial' ? input.finishedAt : undefined,
        lastFailureAt: input.status === 'failed' ? input.finishedAt : undefined,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        syncedSkillCount: input.syncedSkillCount ?? 0,
        syncedFileCount: input.syncedFileCount ?? 0,
        deletedSkillCount: input.deletedSkillCount ?? 0,
        deletedFileCount: input.deletedFileCount ?? 0,
        skippedSkillCount: input.skippedSkillCount ?? 0,
        skippedSkills: input.skippedSkills,
        skippedFileCount: input.skippedFileCount ?? 0,
        skippedFiles: input.skippedFiles,
      };
      statuses.push(status);
      return status;
    }),
    tryAcquireLock: jest.fn(async () => true),
    refreshLock: jest.fn(async () => true),
    releaseLock: jest.fn(async () => undefined),
    createSkill: jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
      return { skill: makeSkill(input), warnings: [] };
    }),
    updateSkill: jest.fn(),
    getSkillById: jest.fn(),
    findSkillBySourceIdentity: jest.fn(async () => null),
    listSkillsBySource: jest.fn(async () => []),
    listSkillFiles: jest.fn(async () => []),
    getSkillFileByPath: jest.fn(async () => null),
    upsertSkillFile: jest.fn(async () => {
      return {
        _id: new Types.ObjectId(),
        skillId: new Types.ObjectId(),
        relativePath: 'scripts/run.sh',
        file_id: 'file-id',
        filename: 'run.sh',
        filepath: '/uploads/file-id__run.sh',
        source: 'local',
        mimeType: 'application/x-sh',
        bytes: 7,
        category: 'script',
        isExecutable: false,
        author: new Types.ObjectId(),
      } as ISkillFile & { _id: Types.ObjectId };
    }),
    deleteSkillFile: jest.fn(async () => ({ deleted: true })),
    deleteSkill: jest.fn(async () => completeSkillDeletion(true)),
    saveBuffer: jest.fn(async () => ({ filepath: '/uploads/file-id__run.sh', source: 'local' })),
    deleteFile: jest.fn(async () => undefined),
    grantPermission: jest.fn(async () => undefined),
    fetchFn: githubFetch(),
    ...overrides,
  };
  return deps;
}

describe('createGitHubSkillSyncRunner', () => {
  it('creates a GitHub skill and syncs bundled files from a configured path', async () => {
    const deps = createDeps();
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();
    const fetchedUrls = (deps.fetchFn as unknown as jest.Mock).mock.calls.map(
      ([input]: [RequestInfo | URL]) => input.toString(),
    );

    expect(result.status).toBe('completed');
    expect(fetchedUrls.some((url) => url.includes('/git/trees/tree-sha?recursive=1'))).toBe(false);
    expect(fetchedUrls.some((url) => url.includes('/git/trees/skills-tree-sha?recursive=1'))).toBe(
      true,
    );
    expect(deps.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'research',
        description: 'Research things',
        body: expect.stringContaining('Body'),
        alwaysApply: true,
        source: 'github',
        sourceMetadata: expect.objectContaining({
          provider: 'github',
          sourceId: 'librechat-skills',
          upstreamId: 'librechat-skills:skills/research',
          skillBlobSha: 'skill-md-sha',
        }),
      }),
    );
    expect(deps.upsertSkillFile).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'scripts/run.sh',
        sourceMetadata: expect.objectContaining({
          upstreamId: 'librechat-skills:skills/research',
          blobSha: 'file-sha',
          commitSha: 'commit-sha',
        }),
      }),
    );
    expect(deps.grantPermission).toHaveBeenCalledWith(
      expect.objectContaining({
        principalType: 'public',
        accessRoleId: 'skill_viewer',
      }),
    );
  });

  it('drops an invalid alwaysApply alias when canonical always-apply is valid', async () => {
    const deps = createDeps({
      fetchFn: githubFetch(
        '---\nname: research\ndescription: Research things\nalways-apply: true\nalwaysApply: yes\n---\nBody',
      ),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deps.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        alwaysApply: true,
        frontmatter: { 'always-apply': true },
      }),
    );
  });

  it('preserves unknown frontmatter key casing while canonicalizing recognized keys', async () => {
    const deps = createDeps({
      fetchFn: githubFetch(
        '---\nname: research\ndescription: Research things\nAllowed-Tools:\n  - execute_code\ncustomConfig: camel\ncustomconfig: lower\n---\nBody',
      ),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deps.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        frontmatter: expect.objectContaining({
          'allowed-tools': ['execute_code'],
          customConfig: 'camel',
          customconfig: 'lower',
        }),
      }),
    );
  });

  it('rejects case-colliding recognized frontmatter keys instead of choosing by order', async () => {
    const deps = createDeps({
      fetchFn: githubFetch(
        '---\nname: research\ndescription: Research things\nallowed-tools:\n  - execute_code\nAllowed-Tools:\n  - web_search\n---\nBody',
      ),
    });

    const result = await createGitHubSkillSyncRunner(deps).runOnce();

    expect(result.status).toBe('failed');
    expect(deps.createSkill).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'SKILL_PARSE_FAILED',
        errorMessage: expect.stringContaining(
          'Recognized frontmatter keys "allowed-tools" and "Allowed-Tools" both resolve to "allowed-tools"',
        ),
      }),
    );
  });

  it('fails duplicate discovered skill names before publishing partial mirrors', async () => {
    const duplicateFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/commits/')) {
        return response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } });
      }
      if (url.includes('/git/trees/tree-sha')) {
        return response({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            {
              path: 'skills',
              mode: '040000',
              type: 'tree',
              sha: 'skills-tree-sha',
              url: 'https://api.github.test/tree/skills',
            },
          ],
        });
      }
      if (url.includes('/git/trees/skills-tree-sha')) {
        return response({
          sha: 'skills-tree-sha',
          truncated: false,
          tree: [
            {
              path: 'research/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'skill-a-sha',
              size: 50,
              url: 'https://api.github.test/blob/skill-a',
            },
            {
              path: 'analysis/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'skill-b-sha',
              size: 50,
              url: 'https://api.github.test/blob/skill-b',
            },
          ],
        });
      }
      if (url.includes('/git/blobs/skill-a-sha')) {
        return response(blob('---\nname: duplicate\ndescription: First\n---\nBody'));
      }
      if (url.includes('/git/blobs/skill-b-sha')) {
        return response(blob('---\nname: duplicate\ndescription: Second\n---\nBody'));
      }
      return response({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    const deps = createDeps({ fetchFn: duplicateFetch });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.createSkill).not.toHaveBeenCalled();
    expect(deps.updateSkill).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'DUPLICATE_SKILL_NAME',
        errorMessage: 'GitHub source "librechat-skills" contains multiple skills named "duplicate"',
      }),
    );
  });

  it('fails duplicate root and nested skill names before publishing partial mirrors', async () => {
    const duplicateFetch = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/commits/')) {
        return response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } });
      }
      if (url.includes('/git/trees/tree-sha')) {
        return response({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            {
              path: 'SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'root-skill-sha',
              size: 50,
              url: 'https://api.github.test/blob/root-skill',
            },
            {
              path: 'child/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'child-skill-sha',
              size: 50,
              url: 'https://api.github.test/blob/child-skill',
            },
          ],
        });
      }
      if (url.includes('/git/blobs/root-skill-sha')) {
        return response(blob('---\nname: duplicate\ndescription: Root\n---\nBody'));
      }
      if (url.includes('/git/blobs/child-skill-sha')) {
        return response(blob('---\nname: duplicate\ndescription: Child\n---\nBody'));
      }
      return response({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    const deps = createDeps({
      fetchFn: duplicateFetch,
      getConfig: () => ({
        github: {
          enabled: true,
          intervalMinutes: 60,
          runOnStartup: false,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              ref: 'main',
              paths: [''],
              credentialKey: 'github-skills-prod',
            },
          ],
        },
      }),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.createSkill).not.toHaveBeenCalled();
    expect(deps.updateSkill).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'DUPLICATE_SKILL_NAME',
        errorMessage: 'GitHub source "librechat-skills" contains multiple skills named "duplicate"',
      }),
    );
  });

  it('publishes the healthy skills of a source and records the ones it had to skip', async () => {
    const deps = createDeps({
      fetchFn: multiSkillFetch([
        {
          dir: 'research',
          markdown: '---\nname: research\ndescription: Research things\n---\nBody',
        },
        { dir: 'broken', markdown: '---\nname: [\n---\nBody' },
        {
          dir: 'analysis',
          markdown: '---\nname: analysis\ndescription: Analyze things\n---\nBody',
        },
      ]),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect((deps.createSkill as jest.Mock).mock.calls.map(([input]) => input.name)).toEqual([
      'research',
      'analysis',
    ]);
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'partial',
        syncedSkillCount: 2,
        skippedSkillCount: 1,
        skippedSkills: [
          expect.objectContaining({
            path: 'skills/broken',
            errorCode: 'SKILL_PARSE_FAILED',
            errorMessage: expect.stringContaining('skills/broken/SKILL.md'),
          }),
        ],
      }),
    );
  });

  it('bounds a skipped skill path so the partial status remains persistable', async () => {
    const longDirectory = 'a'.repeat(600);
    const deps = createDeps({
      fetchFn: multiSkillFetch([
        {
          dir: 'research',
          markdown: '---\nname: research\ndescription: Research things\n---\nBody',
        },
        { dir: longDirectory, markdown: '---\nname: [\n---\nBody' },
      ]),
    });

    const result = await createGitHubSkillSyncRunner(deps).runOnce();

    expect(result.status).toBe('completed');
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'partial',
        syncedSkillCount: 1,
        skippedSkillCount: 1,
        skippedSkills: [
          expect.objectContaining({
            path: expect.stringMatching(/^skills\/a+…$/),
          }),
        ],
      }),
    );
    const statusCalls = (deps.upsertStatus as jest.Mock).mock.calls;
    const status = statusCalls[statusCalls.length - 1]?.[0] as SkillSyncStatusInput;
    expect(status.skippedSkills?.[0].path).toHaveLength(500);
  });

  it('escapes control characters in skipped skill diagnostics', async () => {
    const maliciousDirectory = 'broken\n\x1b[31mforged\u2028line\u2029paragraph';
    const skillMarkdown = '---\nname: broken\ndescription: Broken skill\n---\nBody';
    const fetchFn = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/commits/')) {
        return response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } });
      }
      if (url.includes('/git/trees/tree-sha')) {
        return response({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            {
              path: 'skills',
              mode: '040000',
              type: 'tree',
              sha: 'skills-tree-sha',
              url: 'https://api.github.test/tree/skills',
            },
          ],
        });
      }
      if (url.includes('/git/trees/skills-tree-sha')) {
        return response({
          sha: 'skills-tree-sha',
          truncated: false,
          tree: [
            {
              path: 'healthy/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'healthy-skill-sha',
              size: Buffer.byteLength(skillMarkdown),
              url: 'https://api.github.test/blob/healthy-skill',
            },
            {
              path: `${maliciousDirectory}/SKILL.md`,
              mode: '100644',
              type: 'blob',
              sha: 'malicious-skill-sha',
              size: Buffer.byteLength(skillMarkdown),
              url: 'https://api.github.test/blob/malicious-skill',
            },
          ],
        });
      }
      if (url.includes('/git/blobs/malicious-skill-sha')) {
        return response(blob(skillMarkdown));
      }
      if (url.includes('/git/blobs/healthy-skill-sha')) {
        return response(blob('---\nname: healthy\ndescription: Healthy skill\n---\nHealthy body'));
      }
      return response({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    const deps = createDeps({
      fetchFn,
      createSkill: jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
        if (input.name === 'broken') {
          throw new Error('validation failed\n\x1b[2Jforged\u2028line\u2029paragraph');
        }
        return { skill: makeSkill(input), warnings: [] };
      }),
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    try {
      const result = await createGitHubSkillSyncRunner(deps).runOnce();
      const warning = warn.mock.calls
        .map(([message]) => String(message))
        .find((message) => message.includes(' skipped "'));
      const statusCalls = (deps.upsertStatus as jest.Mock).mock.calls;
      const status = statusCalls[statusCalls.length - 1]?.[0] as SkillSyncStatusInput;

      expect(result.status).toBe('completed');
      expect(warning).toContain('skills/broken\\n\\u001b[31mforged\\u2028line\\u2029paragraph');
      expect(warning).toContain('validation failed\\n\\u001b[2Jforged\\u2028line\\u2029paragraph');
      expect(
        [...(warning ?? '')].every((character) => {
          const codePoint = character.charCodeAt(0);
          return !(
            (codePoint >= 0 && codePoint <= 0x1f) ||
            (codePoint >= 0x7f && codePoint <= 0x9f) ||
            codePoint === 0x2028 ||
            codePoint === 0x2029
          );
        }),
      ).toBe(true);
      expect(status.skippedSkills?.[0]).toEqual(
        expect.objectContaining({
          path: 'skills/broken\\n\\u001b[31mforged\\u2028line\\u2029paragraph',
          errorMessage: 'validation failed\\n\\u001b[2Jforged\\u2028line\\u2029paragraph',
        }),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('bounds and caps per-skill warning logs for a pathological source', async () => {
    const invalidSkills = Array.from({ length: 25 }, (_, index) => ({
      dir: `${index}-${'x'.repeat(600)}`,
      markdown: '---\nname: [\n---\nBody',
    }));
    const deps = createDeps({
      fetchFn: multiSkillFetch([
        {
          dir: 'research',
          markdown: '---\nname: research\ndescription: Research things\n---\nBody',
        },
        ...invalidSkills,
      ]),
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    try {
      const result = await createGitHubSkillSyncRunner(deps).runOnce();
      const warningText = warn.mock.calls.map(([message]) => String(message));
      const perSkillWarnings = warningText.filter((message) => message.includes(' skipped "'));

      expect(result.status).toBe('completed');
      expect(perSkillWarnings).toHaveLength(20);
      expect(perSkillWarnings.every((message) => message.length <= 1100)).toBe(true);
      expect(warningText).toContain(
        '[GitHubSkillSync] Source "librechat-skills" suppressed 5 additional skipped skill warning(s)',
      );
      expect(deps.upsertStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'partial',
          syncedSkillCount: 1,
          skippedSkillCount: 25,
          skippedSkills: expect.any(Array),
        }),
      );
      const statusCalls = (deps.upsertStatus as jest.Mock).mock.calls;
      const status = statusCalls[statusCalls.length - 1]?.[0] as SkillSyncStatusInput;
      expect(status.skippedSkills).toHaveLength(20);
    } finally {
      warn.mockRestore();
    }
  });

  it('bounds a skipped skill name so the partial status remains persistable', async () => {
    const longName = 'b'.repeat(600);
    const deps = createDeps({
      fetchFn: multiSkillFetch([
        {
          dir: 'research',
          markdown: '---\nname: research\ndescription: Research things\n---\nBody',
        },
        {
          dir: 'oversized-name',
          markdown: `---\nname: ${longName}\ndescription: Invalid name\n---\nBody`,
        },
      ]),
      createSkill: jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
        if (input.name === longName) {
          throw new Error('Skill validation failed');
        }
        return { skill: makeSkill(input), warnings: [] };
      }),
    });

    const result = await createGitHubSkillSyncRunner(deps).runOnce();

    expect(result.status).toBe('completed');
    const statusCalls = (deps.upsertStatus as jest.Mock).mock.calls;
    const status = statusCalls[statusCalls.length - 1]?.[0] as SkillSyncStatusInput;
    expect(status).toEqual(
      expect.objectContaining({
        status: 'partial',
        syncedSkillCount: 1,
        skippedSkillCount: 1,
      }),
    );
    expect(status.skippedSkills?.[0].name).toMatch(/^b+…$/);
    expect(status.skippedSkills?.[0].name).toHaveLength(128);
  });

  it('preserves bounded validation details for a skipped skill', async () => {
    const validationError = new Error('Skill validation failed') as Error & {
      code: string;
      issues: Array<{ field: string; code: string; message: string }>;
    };
    validationError.code = 'SKILL_VALIDATION_FAILED';
    validationError.issues = [
      {
        field: 'frontmatter.alwaysApply',
        code: 'INVALID_TYPE',
        message: '"always-apply" must be a boolean',
      },
      {
        field: 'body',
        code: 'INVALID_BODY',
        message: `Bearer github_pat_secret ${'x'.repeat(700)}`,
      },
    ];
    const deps = createDeps({
      fetchFn: multiSkillFetch([
        {
          dir: 'research',
          markdown: '---\nname: research\ndescription: Research things\n---\nBody',
        },
        {
          dir: 'broken',
          markdown: '---\nname: broken\ndescription: Broken\n---\nBody',
        },
      ]),
      createSkill: jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
        if (input.name === 'broken') {
          throw validationError;
        }
        return { skill: makeSkill(input), warnings: [] };
      }),
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    try {
      const result = await createGitHubSkillSyncRunner(deps).runOnce();
      const statusCalls = (deps.upsertStatus as jest.Mock).mock.calls;
      const status = statusCalls[statusCalls.length - 1]?.[0] as SkillSyncStatusInput;
      const skipped = status.skippedSkills?.[0];
      const warningText = warn.mock.calls.map(([message]) => String(message)).join('\n');

      expect(result.status).toBe('completed');
      expect(status).toEqual(
        expect.objectContaining({
          status: 'partial',
          syncedSkillCount: 1,
          skippedSkillCount: 1,
        }),
      );
      expect(skipped).toEqual(
        expect.objectContaining({
          path: 'skills/broken',
          name: 'broken',
          errorCode: 'SKILL_VALIDATION_FAILED',
        }),
      );
      expect(skipped?.errorMessage).toContain('frontmatter.alwaysApply [INVALID_TYPE]');
      expect(skipped?.errorMessage).toContain('Bearer [redacted]');
      expect(skipped?.errorMessage).not.toContain('github_pat_secret');
      expect(skipped?.errorMessage?.length).toBeLessThanOrEqual(500);
      expect(skipped?.errorMessage).toMatch(/…$/);
      expect(warningText).toContain('frontmatter.alwaysApply [INVALID_TYPE]');
      expect(warningText).toContain('Bearer [redacted]');
      expect(warningText).not.toContain('github_pat_secret');
    } finally {
      warn.mockRestore();
    }
  });

  it('logs the validation warnings of a synced skill instead of swallowing them', async () => {
    /* An unrecognized frontmatter key no longer fails the skill, so the log is
       the only place a maintainer learns the upstream SKILL.md carries one:
       a background run has no user-facing surface to report it on. */
    const deps = createDeps({
      createSkill: jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
        return {
          skill: makeSkill(input),
          warnings: [
            {
              field: 'frontmatter.references',
              code: 'UNKNOWN_KEY',
              severity: 'warning',
              message: '"references" is not a recognized frontmatter key',
            },
          ],
        };
      }),
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    try {
      const result = await createGitHubSkillSyncRunner(deps).runOnce();

      expect(result.status).toBe('completed');
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'frontmatter.references [UNKNOWN_KEY]: "references" is not a recognized',
        ),
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('research'));
    } finally {
      warn.mockRestore();
    }
  });

  it('does not log new-skill warnings when publication rolls back', async () => {
    const deps = createDeps({
      createSkill: jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
        return {
          skill: makeSkill(input),
          warnings: [
            {
              field: 'frontmatter.references',
              code: 'UNKNOWN_KEY',
              severity: 'warning',
              message: '"references" is not a recognized frontmatter key',
            },
          ],
        };
      }),
      grantPermission: jest.fn(async () => {
        throw new Error('permission unavailable');
      }),
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    try {
      const result = await createGitHubSkillSyncRunner(deps).runOnce();
      const warningText = warn.mock.calls.map(([message]) => String(message));

      expect(result.status).toBe('failed');
      expect(deps.deleteSkill).toHaveBeenCalledTimes(1);
      expect(warningText.some((message) => message.includes(' synced with warnings:'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('bounds and caps validation warning logs across successfully synced skills', async () => {
    const skills = Array.from({ length: 25 }, (_, index) => ({
      dir: `skill-${index}`,
      markdown: `---\nname: skill-${index}\ndescription: Valid skill ${index}\n---\nBody`,
    }));
    const deps = createDeps({
      fetchFn: multiSkillFetch(skills),
      createSkill: jest.fn(
        async (input: CreateSkillInput): Promise<CreateSkillResult> => ({
          skill: makeSkill(input),
          warnings: [
            {
              field: `frontmatter.${'f'.repeat(300)}`,
              code: 'UNKNOWN_KEY',
              severity: 'warning',
              message: `Unknown key ${'m'.repeat(1000)}`,
            },
          ],
        }),
      ),
    });
    const warn = jest.spyOn(logger, 'warn').mockImplementation(() => logger);

    try {
      const result = await createGitHubSkillSyncRunner(deps).runOnce();
      const warningText = warn.mock.calls.map(([message]) => String(message));
      const validationWarnings = warningText.filter((message) =>
        message.includes(' synced with warnings:'),
      );

      expect(result.status).toBe('completed');
      expect(validationWarnings).toHaveLength(20);
      expect(validationWarnings.every((message) => message.length <= 700)).toBe(true);
      expect(warningText).toContain(
        '[GitHubSkillSync] Source "librechat-skills" suppressed 5 additional synced skill validation warning(s)',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('keeps the previously synced mirror of a skipped skill instead of reconciling it away', async () => {
    const author = makeSourceAuthorId();
    const brokenMirror = makeSkill({
      name: 'broken',
      description: 'Previously valid',
      author,
      authorName: 'GitHub Sync',
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/broken',
      },
    });
    const deps = createDeps({
      fetchFn: multiSkillFetch([
        {
          dir: 'research',
          markdown: '---\nname: research\ndescription: Research things\n---\nBody',
        },
        { dir: 'broken', markdown: '---\nname: [\n---\nBody' },
      ]),
      listSkillsBySource: jest.fn(async () => [brokenMirror]),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deps.deleteSkill).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'partial',
        deletedSkillCount: 0,
        skippedSkillCount: 1,
      }),
    );
  });

  it('skips every member of a duplicate name group and still publishes the unique skills', async () => {
    const deps = createDeps({
      fetchFn: multiSkillFetch([
        { dir: 'first', markdown: '---\nname: duplicate\ndescription: First\n---\nBody' },
        { dir: 'unique', markdown: '---\nname: unique\ndescription: Unique skill\n---\nBody' },
        { dir: 'second', markdown: '---\nname: duplicate\ndescription: Second\n---\nBody' },
      ]),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect((deps.createSkill as jest.Mock).mock.calls.map(([input]) => input.name)).toEqual([
      'unique',
    ]);
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'partial',
        syncedSkillCount: 1,
        skippedSkillCount: 2,
        skippedSkills: [
          expect.objectContaining({ path: 'skills/first', errorCode: 'DUPLICATE_SKILL_NAME' }),
          expect.objectContaining({ path: 'skills/second', errorCode: 'DUPLICATE_SKILL_NAME' }),
        ],
      }),
    );
  });

  it('fails the whole source when GitHub starts rate limiting part way through', async () => {
    const deps = createDeps({
      fetchFn: multiSkillFetch(
        [
          {
            dir: 'research',
            markdown: '---\nname: research\ndescription: Research things\n---\nBody',
          },
          { dir: 'analysis', markdown: '---\nname: analysis\ndescription: Analyze\n---\nBody' },
        ],
        { rateLimitedDirs: ['analysis'] },
      ),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    /* A refusal that will hit every remaining request is not the fault of the
       skill that ran into it first, so it must not be filed as one skipped
       skill on an otherwise healthy run. */
    expect(result.status).toBe('failed');
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'GITHUB_RATE_LIMITED',
        skippedSkillCount: 0,
      }),
    );
  });

  it.each([
    ['returns a server error', { requestFailedDirs: ['analysis'] }],
    ['rejects the request', { rejectedDirs: ['analysis'] }],
  ])('fails the whole source when GitHub %s', async (_description, fetchOptions) => {
    const deps = createDeps({
      fetchFn: multiSkillFetch(
        [
          {
            dir: 'research',
            markdown: '---\nname: research\ndescription: Research things\n---\nBody',
          },
          { dir: 'analysis', markdown: '---\nname: analysis\ndescription: Analyze\n---\nBody' },
        ],
        fetchOptions,
      ),
    });

    const result = await createGitHubSkillSyncRunner(deps).runOnce();

    expect(result.status).toBe('failed');
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'GITHUB_REQUEST_FAILED',
        skippedSkillCount: 0,
      }),
    );
  });

  it('preserves earlier skipped skill details when a later request is rate limited', async () => {
    const deps = createDeps({
      fetchFn: multiSkillFetch(
        [
          { dir: 'broken', markdown: '---\nname: [\n---\nBody' },
          {
            dir: 'analysis',
            markdown: '---\nname: analysis\ndescription: Analyze\n---\nBody',
          },
        ],
        { rateLimitedDirs: ['analysis'] },
      ),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'GITHUB_RATE_LIMITED',
        skippedSkillCount: 1,
        skippedSkills: [
          expect.objectContaining({
            path: 'skills/broken',
            errorCode: 'SKILL_PARSE_FAILED',
          }),
        ],
      }),
    );
  });

  it('discovers nested skill roots within the configured discovery depth', async () => {
    const skillMarkdown = '---\nname: tdd\ndescription: Test-driven development\n---\nBody';
    const fetchFn = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/commits/')) {
        return response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } });
      }
      if (url.includes('/git/trees/tree-sha')) {
        return response({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            {
              path: 'skills',
              mode: '040000',
              type: 'tree',
              sha: 'skills-tree-sha',
              url: 'https://api.github.test/tree/skills',
            },
          ],
        });
      }
      if (url.includes('/git/trees/skills-tree-sha')) {
        return response({
          sha: 'skills-tree-sha',
          truncated: false,
          tree: [
            {
              path: 'engineering/tdd/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'skill-md-sha',
              size: Buffer.byteLength(skillMarkdown),
              url: 'https://api.github.test/blob/skill',
            },
            {
              path: 'engineering/tdd/tests.md',
              mode: '100644',
              type: 'blob',
              sha: 'tests-md-sha',
              size: 5,
              url: 'https://api.github.test/blob/tests',
            },
          ],
        });
      }
      if (url.includes('/git/blobs/skill-md-sha')) {
        return response(blob(skillMarkdown));
      }
      if (url.includes('/git/blobs/tests-md-sha')) {
        return response(blob('tests'));
      }
      return response({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    const deps = createDeps({
      fetchFn,
      getConfig: () => ({
        github: {
          enabled: true,
          intervalMinutes: 60,
          runOnStartup: false,
          sources: [
            {
              id: 'mattpocock-skills',
              owner: 'mattpocock',
              repo: 'skills',
              ref: 'main',
              paths: ['skills'],
              skillDiscoveryDepth: 2,
              credentialKey: 'github-skills-prod',
            },
          ],
        },
      }),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deps.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'tdd',
        sourceMetadata: expect.objectContaining({
          sourceId: 'mattpocock-skills',
          upstreamId: 'mattpocock-skills:skills/engineering/tdd',
        }),
      }),
    );
    expect(deps.upsertSkillFile).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'tests.md',
        sourceMetadata: expect.objectContaining({
          path: 'skills/engineering/tdd/tests.md',
        }),
      }),
    );
  });

  it('uses an env-backed source token without loading a stored credential', async () => {
    const previousToken = process.env.GITHUB_SKILLS_TOKEN;
    process.env.GITHUB_SKILLS_TOKEN = 'github_pat_from_env';
    const getCredentialToken = jest.fn(async () => 'github_pat_from_db');
    const deps = createDeps({
      getCredentialToken,
      getConfig: () => ({
        github: {
          enabled: true,
          intervalMinutes: 60,
          runOnStartup: false,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              ref: 'main',
              paths: ['skills'],
              token: '${GITHUB_SKILLS_TOKEN}',
            },
          ],
        },
      }),
    });
    const runner = createGitHubSkillSyncRunner(deps);

    try {
      const status = await runner.getStatus();
      const result = await runner.runOnce();

      expect(status.sources[0]?.credentialPresent).toBe(true);
      expect(result.status).toBe('completed');
      expect(getCredentialToken).not.toHaveBeenCalled();
      expect(deps.createSkill).toHaveBeenCalledWith(
        expect.objectContaining({
          sourceMetadata: expect.objectContaining({ sourceId: 'librechat-skills' }),
        }),
      );
    } finally {
      if (previousToken == null) {
        delete process.env.GITHUB_SKILLS_TOKEN;
      } else {
        process.env.GITHUB_SKILLS_TOKEN = previousToken;
      }
    }
  });

  it('does not list or resolve server credentials and skips runs when they are disabled', async () => {
    const previousToken = process.env.GITHUB_SKILLS_TOKEN;
    process.env.GITHUB_SKILLS_TOKEN = 'github_pat_from_env';
    const getCredentialToken = jest.fn(async () => 'github_pat_from_db');
    const listCredentials = jest.fn(async () => [
      {
        provider: 'github' as const,
        credentialKey: 'github-skills-prod',
        credentialPresent: true,
        tokenFingerprint: 'abc123',
      },
    ]);
    const deps = createDeps({
      allowServerCredentials: false,
      getCredentialToken,
      listCredentials,
      getConfig: () => ({
        github: {
          enabled: true,
          intervalMinutes: 60,
          runOnStartup: false,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              ref: 'main',
              paths: ['skills'],
              token: '${GITHUB_SKILLS_TOKEN}',
            },
            {
              id: 'stored-credential-skills',
              owner: 'LibreChat',
              repo: 'skills',
              ref: 'main',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
            },
          ],
        },
      }),
    });
    const runner = createGitHubSkillSyncRunner(deps);

    try {
      const status = await runner.getStatus();
      const result = await runner.runOnce();

      expect(status.credentials).toEqual([]);
      expect(status.sources).toEqual([
        expect.objectContaining({ sourceId: 'librechat-skills', credentialPresent: false }),
        expect.objectContaining({
          sourceId: 'stored-credential-skills',
          credentialPresent: false,
        }),
      ]);
      expect(result.status).toBe('skipped');
      expect(result.message).toBe(
        'GitHub skill sync credentials are not available for this runner',
      );
      expect(result.sources).toEqual([
        expect.objectContaining({ sourceId: 'librechat-skills', credentialPresent: false }),
        expect.objectContaining({
          sourceId: 'stored-credential-skills',
          credentialPresent: false,
        }),
      ]);
      expect(listCredentials).not.toHaveBeenCalled();
      expect(getCredentialToken).not.toHaveBeenCalled();
      expect(deps.fetchFn).not.toHaveBeenCalled();
      expect(deps.tryAcquireLock).not.toHaveBeenCalled();
      expect(deps.upsertStatus).not.toHaveBeenCalled();
    } finally {
      if (previousToken == null) {
        delete process.env.GITHUB_SKILLS_TOKEN;
      } else {
        process.env.GITHUB_SKILLS_TOKEN = previousToken;
      }
    }
  });

  it('preserves slash-delimited refs when fetching the GitHub commit', async () => {
    const baseFetch = githubFetch();
    const fetchFn = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/commits/')) {
        expect(url).toContain('/commits/heads/release/2026-05');
        expect(url).not.toContain('heads%2Frelease%2F2026-05');
      }
      return baseFetch(input);
    }) as unknown as typeof fetch;
    const deps = createDeps({
      fetchFn,
      getConfig: () => ({
        github: {
          enabled: true,
          intervalMinutes: 60,
          runOnStartup: false,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              ref: 'heads/release/2026-05',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
            },
          ],
        },
      }),
    });
    const result = await createGitHubSkillSyncRunner(deps).runOnce();

    expect(result.status).toBe('completed');
    expect(fetchFn).toHaveBeenCalled();
  });

  it('runs a tenant-scoped source inside its tenant context and stamps the skill tenantId', async () => {
    let observedTenantId: string | undefined = 'unset';
    const deps = createDeps({
      getConfig: () => ({
        github: {
          enabled: true,
          intervalMinutes: 60,
          runOnStartup: false,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              ref: 'main',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
              tenantId: 'tenant-a',
            },
          ],
        },
      }),
      createSkill: jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
        observedTenantId = getTenantId();
        return { skill: makeSkill(input), warnings: [] };
      }),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(observedTenantId).toBe('tenant-a');
    expect(deps.findSkillBySourceIdentity).toHaveBeenCalledWith({
      source: 'github',
      upstreamId: 'librechat-skills:skills/research',
      tenantId: 'tenant-a',
    });
    expect(deps.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'research', tenantId: 'tenant-a' }),
    );
    expect(deps.upsertStatus).toHaveBeenCalledWith(
      expect.objectContaining({ sourceId: 'librechat-skills', tenantId: 'tenant-a' }),
    );
    const [lockParams] = (deps.tryAcquireLock as jest.Mock).mock.calls[0];
    expect(lockParams).not.toHaveProperty('tenantId');
  });

  it('matches stored source status by tenant and source id', async () => {
    const deps = createDeps({
      listStatuses: jest.fn(async () => [
        {
          provider: 'github',
          sourceId: 'librechat-skills',
          tenantId: 'tenant-a',
          status: 'succeeded',
          syncedSkillCount: 1,
          syncedFileCount: 2,
          deletedSkillCount: 0,
          deletedFileCount: 0,
        } as ISkillSyncStatus,
        {
          provider: 'github',
          sourceId: 'librechat-skills',
          tenantId: 'tenant-b',
          status: 'failed',
          errorCode: 'OTHER_TENANT',
          syncedSkillCount: 0,
          syncedFileCount: 0,
          deletedSkillCount: 0,
          deletedFileCount: 0,
        } as ISkillSyncStatus,
      ]),
      getConfig: () => ({
        github: {
          enabled: true,
          intervalMinutes: 60,
          runOnStartup: false,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              ref: 'main',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
              tenantId: 'tenant-b',
            },
          ],
        },
      }),
    });

    const status = await createGitHubSkillSyncRunner(deps).getStatus();

    expect(status.sources[0]).toEqual(
      expect.objectContaining({
        sourceId: 'librechat-skills',
        tenantId: 'tenant-b',
        status: 'failed',
        errorCode: 'OTHER_TENANT',
      }),
    );
  });

  it('runs in the ambient context when a source has no configured tenantId', async () => {
    let observedTenantId: string | undefined = 'unset';
    const deps = createDeps({
      createSkill: jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
        observedTenantId = getTenantId();
        return { skill: makeSkill(input), warnings: [] };
      }),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(observedTenantId).toBeUndefined();
    expect(deps.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'research', tenantId: undefined }),
    );
  });

  it('scopes mirror cleanup to the current source and deletes only its absent upstream skills', async () => {
    const keptId = new Types.ObjectId();
    const staleId = new Types.ObjectId();
    const existingSkill = (upstreamId: string, _id: Types.ObjectId) => {
      const skill = makeSkill({
        name: 'research',
        description: 'Research things',
        author: new Types.ObjectId(),
        authorName: 'GitHub Sync',
        source: 'github',
        sourceMetadata: { provider: 'github', sourceId: 'librechat-skills', upstreamId },
      });
      skill._id = _id;
      return skill;
    };
    const listSkillsBySource = jest.fn(async () => [
      existingSkill('librechat-skills:skills/research', keptId),
      existingSkill('librechat-skills:skills/removed', staleId),
    ]);
    const deps = createDeps({ listSkillsBySource });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(listSkillsBySource).toHaveBeenCalledWith({
      source: 'github',
      sourceId: 'librechat-skills',
    });
    expect(deps.deleteSkill).toHaveBeenCalledTimes(1);
    expect(deps.deleteSkill).toHaveBeenCalledWith(staleId.toString());
  });

  it('deletes stale name-conflicting mirrors after file sync and before same-commit renames', async () => {
    const staleId = new Types.ObjectId();
    const existingId = new Types.ObjectId();
    const author = makeSourceAuthorId();
    const existingSkill = (
      upstreamId: string,
      _id: Types.ObjectId,
      name: string,
    ): ISkill & { _id: Types.ObjectId } => {
      const skill = makeSkill({
        name,
        description: `${name} skill`,
        body: 'Old body',
        author,
        authorName: 'GitHub Sync',
        source: 'github',
        sourceMetadata: { provider: 'github', sourceId: 'librechat-skills', upstreamId },
      });
      skill._id = _id;
      return skill;
    };
    const staleSkill = existingSkill('librechat-skills:skills/removed', staleId, 'renamed');
    const syncedSkill = existingSkill('librechat-skills:skills/research', existingId, 'research');
    const existingById = new Map([[existingId.toString(), syncedSkill]]);
    const deletedIds = new Set<string>();
    const listSkillsBySource = jest.fn(async () =>
      [staleSkill, syncedSkill].filter((skill) => !deletedIds.has(skill._id.toString())),
    );
    const deleteSkill = jest.fn(async (id: string) => {
      deletedIds.add(id);
      return completeSkillDeletion(true);
    });
    const updateSkill = jest.fn(
      async ({
        id,
        update,
      }: {
        id: string;
        expectedVersion: number;
        update: UpdateSkillInput;
      }): Promise<UpdateSkillResult> => {
        if (!deletedIds.has(staleId.toString()) && update.name === 'renamed') {
          throw new Error('duplicate key');
        }
        const skill = existingById.get(id);
        if (!skill) {
          return { status: 'not_found' as const };
        }
        const updated = { ...skill, ...update, version: skill.version + 1 };
        existingById.set(id, updated);
        return { status: 'updated' as const, skill: updated, warnings: [] };
      },
    );
    const deps = createDeps({
      fetchFn: githubFetch('---\nname: renamed\ndescription: Renamed skill\n---\nBody'),
      findSkillBySourceIdentity: jest.fn(async ({ upstreamId }) =>
        upstreamId === 'librechat-skills:skills/research' ? syncedSkill : null,
      ),
      getSkillById: jest.fn(async (id) => existingById.get(id.toString()) ?? null),
      listSkillsBySource,
      deleteSkill,
      updateSkill,
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deleteSkill).toHaveBeenCalledWith(staleId.toString());
    expect(updateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        id: existingId.toString(),
        update: expect.objectContaining({ name: 'renamed' }),
      }),
    );
    expect((deps.upsertSkillFile as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan(
      deleteSkill.mock.invocationCallOrder[0],
    );
    expect(deleteSkill.mock.invocationCallOrder[0]).toBeLessThan(
      updateSkill.mock.invocationCallOrder[0],
    );
  });

  it('keeps a failed skill mirror while still reconciling a mirror whose upstream root is gone', async () => {
    const renamedMarkdown = '---\nname: renamed\ndescription: Renamed skill\n---\nBody';
    const brokenMarkdown = '---\nname: broken\ndescription: Broken skill\n---\nBody';
    const fetchFn = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/commits/')) {
        return response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } });
      }
      if (url.includes('/git/trees/tree-sha')) {
        return response({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            {
              path: 'skills',
              mode: '040000',
              type: 'tree',
              sha: 'skills-tree-sha',
              url: 'https://api.github.test/tree/skills',
            },
          ],
        });
      }
      if (url.includes('/git/trees/skills-tree-sha')) {
        return response({
          sha: 'skills-tree-sha',
          truncated: false,
          tree: [
            {
              path: 'research/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'research-skill-sha',
              size: Buffer.byteLength(renamedMarkdown),
              url: 'https://api.github.test/blob/research-skill',
            },
            {
              path: 'research/scripts/run.sh',
              mode: '100644',
              type: 'blob',
              sha: 'research-file-sha',
              size: 7,
              url: 'https://api.github.test/blob/research-file',
            },
            {
              path: 'broken/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'broken-skill-sha',
              size: Buffer.byteLength(brokenMarkdown),
              url: 'https://api.github.test/blob/broken-skill',
            },
            {
              path: 'broken/scripts/run.sh',
              mode: '100644',
              type: 'blob',
              sha: 'broken-file-sha',
              size: 7,
              url: 'https://api.github.test/blob/broken-file',
            },
          ],
        });
      }
      if (url.includes('/git/blobs/research-skill-sha')) {
        return response(blob(renamedMarkdown));
      }
      if (url.includes('/git/blobs/broken-skill-sha')) {
        return response(blob(brokenMarkdown));
      }
      if (url.includes('/git/blobs/research-file-sha')) {
        return response(blob('echo ok'));
      }
      if (url.includes('/git/blobs/broken-file-sha')) {
        return response(blob('echo ok'));
      }
      return response({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    const staleId = new Types.ObjectId();
    const existingId = new Types.ObjectId();
    const author = makeSourceAuthorId();
    const makeExisting = (
      upstreamId: string,
      _id: Types.ObjectId,
      name: string,
    ): ISkill & { _id: Types.ObjectId } => {
      const skill = makeSkill({
        name,
        description: `${name} skill`,
        body: 'Old body',
        author,
        authorName: 'GitHub Sync',
        source: 'github',
        sourceMetadata: { provider: 'github', sourceId: 'librechat-skills', upstreamId },
      });
      skill._id = _id;
      return skill;
    };
    const staleSkill = makeExisting('librechat-skills:skills/removed', staleId, 'renamed');
    const syncedSkill = makeExisting('librechat-skills:skills/research', existingId, 'research');
    const createdIds: string[] = [];
    const deleteSkill = jest.fn(async (id: string) =>
      completeSkillDeletion(createdIds.includes(id)),
    );
    const deps = createDeps({
      fetchFn,
      findSkillBySourceIdentity: jest.fn(async ({ upstreamId }) =>
        upstreamId === 'librechat-skills:skills/research' ? syncedSkill : null,
      ),
      getSkillById: jest.fn(async (id) =>
        id.toString() === existingId.toString() ? syncedSkill : null,
      ),
      listSkillsBySource: jest.fn(async () => [staleSkill, syncedSkill]),
      createSkill: jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
        const skill = makeSkill(input);
        createdIds.push(skill._id.toString());
        return { skill, warnings: [] };
      }),
      saveBuffer: jest.fn(async () => {
        throw new Error('storage unavailable');
      }),
      deleteSkill,
      updateSkill: jest.fn(),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    /* The failed skill is still present upstream, so its mirror survives for a
       later run to repair. The stale mirror is a different question: its
       upstream root is gone, so reconciling it away is correct regardless of
       which skills failed. */
    expect(deleteSkill).not.toHaveBeenCalledWith(existingId.toString());
    expect(deps.updateSkill).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorMessage: 'storage unavailable',
        skippedSkillCount: 2,
      }),
    );
  });

  it('fails the source when recreating a stale mirror cannot preserve its dependent state', async () => {
    const staleId = new Types.ObjectId();
    const existingId = new Types.ObjectId();
    const author = makeSourceAuthorId();
    const makeExisting = (
      upstreamId: string,
      _id: Types.ObjectId,
      name: string,
    ): ISkill & { _id: Types.ObjectId } => {
      const skill = makeSkill({
        name,
        description: `${name} skill`,
        body: 'Old body',
        author,
        authorName: 'GitHub Sync',
        source: 'github',
        sourceMetadata: { provider: 'github', sourceId: 'librechat-skills', upstreamId },
      });
      skill._id = _id;
      return skill;
    };
    const staleSkill = makeExisting('librechat-skills:skills/removed', staleId, 'renamed');
    const syncedSkill = makeExisting('librechat-skills:skills/research', existingId, 'research');
    const persistedSkills = new Map(
      [staleSkill, syncedSkill].map((skill) => [skill._id.toString(), skill]),
    );
    let restoredSkill: (ISkill & { _id: Types.ObjectId }) | undefined;
    const createSkill = jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
      restoredSkill = makeSkill(input);
      persistedSkills.set(restoredSkill._id.toString(), restoredSkill);
      return { skill: restoredSkill, warnings: [] };
    });
    const deleteSkill = jest.fn(async (id: string) => {
      return completeSkillDeletion(persistedSkills.delete(id));
    });
    const deps = createDeps({
      fetchFn: githubFetch('---\nname: renamed\ndescription: Renamed skill\n---\nBody'),
      findSkillBySourceIdentity: jest.fn(async ({ upstreamId }) =>
        upstreamId === 'librechat-skills:skills/research' ? syncedSkill : null,
      ),
      getSkillById: jest.fn(async (id) =>
        id.toString() === existingId.toString() ? syncedSkill : null,
      ),
      listSkillsBySource: jest.fn(async () => [...persistedSkills.values()]),
      createSkill,
      deleteSkill,
      updateSkill: jest.fn(async () => ({ status: 'conflict' as const, current: syncedSkill })),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deleteSkill).toHaveBeenCalledWith(staleId.toString());
    expect(deleteSkill).toHaveBeenCalledTimes(1);
    expect(createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'renamed',
        sourceMetadata: expect.objectContaining({
          upstreamId: 'librechat-skills:skills/removed',
        }),
      }),
    );
    expect(deps.grantPermission).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: restoredSkill?._id }),
    );
    expect(persistedSkills.has(restoredSkill?._id.toString() ?? '')).toBe(true);
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'SYNC_ROLLBACK_FAILED',
        errorMessage: 'Rollback failed after: Skill "research" changed during sync',
        deletedSkillCount: 0,
        deletedFileCount: 0,
      }),
    );
  });

  it.each([
    { failedStep: 'skill_files' as const, expectedBlobDeletes: 0 },
    { failedStep: 'permissions' as const, expectedBlobDeletes: 1 },
  ])(
    'fails the source and safely handles blobs when stale deletion leaves $failedStep incomplete',
    async ({ failedStep, expectedBlobDeletes }) => {
      const staleId = new Types.ObjectId();
      const existingId = new Types.ObjectId();
      const author = makeSourceAuthorId();
      const makeExisting = (
        upstreamId: string,
        _id: Types.ObjectId,
        name: string,
      ): ISkill & { _id: Types.ObjectId } => {
        const skill = makeSkill({
          name,
          description: `${name} skill`,
          author,
          authorName: 'GitHub Sync',
          source: 'github',
          sourceMetadata: { provider: 'github', sourceId: 'librechat-skills', upstreamId },
        });
        skill._id = _id;
        return skill;
      };
      const staleSkill = makeExisting('librechat-skills:skills/removed', staleId, 'renamed');
      const syncedSkill = makeExisting('librechat-skills:skills/research', existingId, 'research');
      const deleteSkill = jest.fn(async (id: string) => {
        if (id === staleId.toString()) {
          return incompleteSkillDeletion([failedStep]);
        }
        return completeSkillDeletion(true);
      });
      const staleFile = {
        _id: new Types.ObjectId(),
        skillId: staleId,
        relativePath: 'references/stale.md',
        filepath: '/uploads/stale.md',
        source: 'local',
        author,
      } as ISkillFile & { _id: Types.ObjectId };
      const deleteFile = jest.fn(
        async (_file: Parameters<NonNullable<GitHubSkillSyncDeps['deleteFile']>>[0]) => undefined,
      );
      const deps = createDeps({
        fetchFn: githubFetch('---\nname: renamed\ndescription: Renamed skill\n---\nBody'),
        findSkillBySourceIdentity: jest.fn(async ({ upstreamId }) =>
          upstreamId === 'librechat-skills:skills/research' ? syncedSkill : null,
        ),
        getSkillById: jest.fn(async (id) =>
          id.toString() === existingId.toString() ? syncedSkill : null,
        ),
        listSkillsBySource: jest.fn(async () => [staleSkill, syncedSkill]),
        listSkillFiles: jest.fn(async (id) =>
          id.toString() === staleId.toString() ? [staleFile] : [],
        ),
        deleteFile,
        deleteSkill,
        updateSkill: jest.fn(),
      });
      const runner = createGitHubSkillSyncRunner(deps);
      const result = await runner.runOnce();

      expect(result.status).toBe('failed');
      expect(deleteSkill).toHaveBeenCalledWith(staleId.toString());
      const staleBlobCalls = deleteFile.mock.calls.filter(
        ([file]) => file.filepath === staleFile.filepath,
      );
      expect(staleBlobCalls).toHaveLength(expectedBlobDeletes);
      expect(deps.updateSkill).not.toHaveBeenCalled();
      expect(deps.upsertStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'failed',
          errorCode: 'SYNC_ROLLBACK_FAILED',
          errorMessage: `Stale mirror deletion failed: Skill cleanup did not finish: ${failedStep}`,
        }),
      );
    },
  );

  it("does not mirror-delete another tenant's skills from an ambient source run", async () => {
    const ambientStaleId = new Types.ObjectId();
    const otherTenantId = new Types.ObjectId();
    const makeExisting = (
      upstreamId: string,
      _id: Types.ObjectId,
      tenantId?: string,
    ): ISkill & { _id: Types.ObjectId } => {
      const skill = makeSkill({
        name: 'research',
        description: 'Research things',
        author: new Types.ObjectId(),
        authorName: 'GitHub Sync',
        source: 'github',
        sourceMetadata: { provider: 'github', sourceId: 'librechat-skills', upstreamId },
      });
      skill._id = _id;
      skill.tenantId = tenantId;
      return skill;
    };
    // The configured source is ambient (no tenantId), but listSkillsBySource
    // (non-strict) returns a skill owned by tenant-b. It must not be deleted.
    const listSkillsBySource = jest.fn(async () => [
      makeExisting('librechat-skills:skills/removed', ambientStaleId, undefined),
      makeExisting('librechat-skills:skills/removed', otherTenantId, 'tenant-b'),
    ]);
    const deps = createDeps({ listSkillsBySource });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deps.deleteSkill).toHaveBeenCalledTimes(1);
    expect(deps.deleteSkill).toHaveBeenCalledWith(ambientStaleId.toString());
    expect(deps.deleteSkill).not.toHaveBeenCalledWith(otherTenantId.toString());
  });

  it('derives distinct synthetic authors for the same source mirrored into different tenants', async () => {
    const authorForTenant = async (tenantId: string): Promise<string> => {
      let author = '';
      const deps = createDeps({
        getConfig: () => ({
          github: {
            enabled: true,
            intervalMinutes: 60,
            runOnStartup: false,
            sources: [
              {
                id: 'librechat-skills',
                owner: 'LibreChat',
                repo: 'skills',
                ref: 'main',
                paths: ['skills'],
                credentialKey: 'github-skills-prod',
                tenantId,
              },
            ],
          },
        }),
        createSkill: jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
          author = input.author.toString();
          return { skill: makeSkill(input), warnings: [] };
        }),
      });
      await createGitHubSkillSyncRunner(deps).runOnce();
      return author;
    };

    const [authorA, authorB] = [
      await authorForTenant('tenant-a'),
      await authorForTenant('tenant-b'),
    ];
    expect(authorA).not.toBe('');
    expect(authorA).not.toBe(authorB);
  });

  it('uses distinct synthetic authors so same-named skills can sync from different sources', async () => {
    const seenNamesByAuthor = new Set<string>();
    const deps = createDeps({
      getConfig: () => ({
        github: {
          enabled: true,
          intervalMinutes: 60,
          runOnStartup: false,
          sources: [
            {
              id: 'source-a',
              owner: 'LibreChat',
              repo: 'skills-a',
              ref: 'main',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
            },
            {
              id: 'source-b',
              owner: 'LibreChat',
              repo: 'skills-b',
              ref: 'main',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
            },
          ],
        },
      }),
      createSkill: jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
        const key = `${input.name}:${input.author.toString()}`;
        if (seenNamesByAuthor.has(key)) {
          throw new Error('duplicate key');
        }
        seenNamesByAuthor.add(key);
        return { skill: makeSkill(input), warnings: [] };
      }),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();
    const createCalls = (deps.createSkill as jest.Mock).mock.calls.map(
      ([input]: [CreateSkillInput]) => input,
    );

    expect(result.status).toBe('completed');
    expect(createCalls).toHaveLength(2);
    expect(createCalls.map((input) => input.name)).toEqual(['research', 'research']);
    expect(new Set(createCalls.map((input) => input.author.toString())).size).toBe(2);
  });

  it('marks a source failed and skips mirror deletion when the credential is missing', async () => {
    const deps = createDeps({
      getCredentialToken: jest.fn(async () => null),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.listSkillsBySource).not.toHaveBeenCalled();
    expect(deps.deleteSkill).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'MISSING_CREDENTIAL',
      }),
    );
  });

  it('marks GitHub secondary rate limits as rate limited instead of auth failures', async () => {
    const deps = createDeps({
      fetchFn: jest.fn(async () =>
        response(
          { message: 'You have exceeded a secondary rate limit. Please wait before retrying.' },
          403,
          { 'x-ratelimit-remaining': '42' },
        ),
      ) as unknown as typeof fetch,
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'GITHUB_RATE_LIMITED',
      }),
    );
  });

  it('keeps non-rate-limit GitHub 403 responses classified as auth failures', async () => {
    const deps = createDeps({
      fetchFn: jest.fn(async () =>
        response({ message: 'Resource not accessible by personal access token' }, 403, {
          'x-ratelimit-remaining': '42',
        }),
      ) as unknown as typeof fetch,
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'GITHUB_AUTH_FAILED',
      }),
    );
  });

  it('marks a source failed and skips mirror deletion when SKILL.md frontmatter is malformed', async () => {
    const movedMirror = makeSkill({
      name: 'research',
      description: 'Last known good description',
      author: makeSourceAuthorId(),
      authorName: 'GitHub Sync',
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/old-research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const deps = createDeps({
      fetchFn: githubFetch('---\nname: [\n---\nBody'),
      listSkillsBySource: jest.fn(async () => [movedMirror]),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.createSkill).not.toHaveBeenCalled();
    expect(deps.deleteSkill).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'SKILL_PARSE_FAILED',
        errorMessage: expect.stringContaining('skills/research/SKILL.md'),
        skippedSkillCount: 1,
      }),
    );
  });

  it('does not create a conflicting moved skill after another skill fails preparation', async () => {
    const lastKnownGood = makeSkill({
      name: 'research',
      description: 'Last known good description',
      author: makeSourceAuthorId(),
      authorName: 'GitHub Sync',
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/old-research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const deps = createDeps({
      fetchFn: multiSkillFetch([
        { dir: 'broken', markdown: '---\nname: [\n---\nBody' },
        {
          dir: 'healthy',
          markdown: '---\nname: research\ndescription: Healthy replacement candidate\n---\nBody',
        },
        {
          dir: 'unique',
          markdown: '---\nname: analysis\ndescription: Independent healthy skill\n---\nBody',
        },
      ]),
      listSkillsBySource: jest.fn(async () => [lastKnownGood]),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deps.updateSkill).not.toHaveBeenCalled();
    expect(deps.deleteSkill).not.toHaveBeenCalled();
    expect(deps.createSkill).toHaveBeenCalledTimes(1);
    expect(deps.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'analysis',
        sourceMetadata: expect.objectContaining({
          upstreamId: 'librechat-skills:skills/unique',
        }),
      }),
    );
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'partial',
        syncedSkillCount: 1,
        skippedSkillCount: 2,
        skippedSkills: expect.arrayContaining([
          expect.objectContaining({
            path: 'skills/healthy',
            errorCode: 'SKILL_MOVE_AMBIGUOUS',
          }),
        ]),
      }),
    );
  });

  it('uses a ref-independent upstream identity when updating an existing GitHub skill', async () => {
    const existing = makeSkill({
      name: 'research',
      description: 'Old description',
      author: new Types.ObjectId(),
      authorName: 'GitHub Sync',
      frontmatter: { 'allowed-tools': ['old-tool'] },
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const deps = createDeps({
      getConfig: () => ({
        github: {
          enabled: true,
          intervalMinutes: 60,
          runOnStartup: false,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              ref: 'release',
              paths: ['skills'],
              credentialKey: 'github-skills-prod',
            },
          ],
        },
      }),
      findSkillBySourceIdentity: jest.fn(async () => existing),
      getSkillById: jest.fn(async () => ({ ...existing, version: existing.version + 1 })),
      fetchFn: githubFetch('---\nname: research\ndescription: Research things\n---\nBody'),
      updateSkill: jest.fn(async ({ update }) => ({
        status: 'updated' as const,
        skill: {
          ...existing,
          ...update,
          version: existing.version + 1,
        },
        warnings: [],
      })),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deps.findSkillBySourceIdentity).toHaveBeenCalledWith({
      source: 'github',
      upstreamId: 'librechat-skills:skills/research',
      tenantId: undefined,
    });
    expect(deps.createSkill).not.toHaveBeenCalled();
    expect(deps.updateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          sourceMetadata: expect.objectContaining({
            ref: 'release',
            upstreamId: 'librechat-skills:skills/research',
          }),
          frontmatter: {},
        }),
      }),
    );
  });

  it('ignores source identity matches from a different tenant bucket', async () => {
    const otherTenantSkill = makeSkill({
      name: 'research',
      description: 'Tenant skill',
      author: makeSourceAuthorId('librechat-skills', 'tenant-b'),
      authorName: 'GitHub Sync',
      frontmatter: {},
      source: 'github',
      tenantId: 'tenant-b',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const deps = createDeps({
      findSkillBySourceIdentity: jest.fn(async () => otherTenantSkill),
      listSkillsBySource: jest.fn(async () => [otherTenantSkill]),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deps.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'research',
        tenantId: undefined,
      }),
    );
    expect(deps.updateSkill).not.toHaveBeenCalled();
    expect(deps.deleteSkill).not.toHaveBeenCalledWith(otherTenantSkill._id.toString());
  });

  it('does not match still-discovered mirrors as moved skills when new skills sync first', async () => {
    const newSkillMarkdown = '---\nname: research\ndescription: New research skill\n---\nNew';
    const renamedSkillMarkdown = '---\nname: renamed\ndescription: Renamed skill\n---\nRenamed';
    const fetchFn = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/commits/')) {
        return response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } });
      }
      if (url.includes('/git/trees/tree-sha')) {
        return response({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            {
              path: 'skills',
              mode: '040000',
              type: 'tree',
              sha: 'skills-tree-sha',
              url: 'https://api.github.test/tree/skills',
            },
          ],
        });
      }
      if (url.includes('/git/trees/skills-tree-sha')) {
        return response({
          sha: 'skills-tree-sha',
          truncated: false,
          tree: [
            {
              path: 'new/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'new-skill-sha',
              size: Buffer.byteLength(newSkillMarkdown),
              url: 'https://api.github.test/blob/new-skill',
            },
            {
              path: 'research/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'renamed-skill-sha',
              size: Buffer.byteLength(renamedSkillMarkdown),
              url: 'https://api.github.test/blob/renamed-skill',
            },
          ],
        });
      }
      if (url.includes('/git/blobs/new-skill-sha')) {
        return response(blob(newSkillMarkdown));
      }
      if (url.includes('/git/blobs/renamed-skill-sha')) {
        return response(blob(renamedSkillMarkdown));
      }
      return response({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    const existing = makeSkill({
      name: 'research',
      description: 'Old research skill',
      body: 'Old body',
      author: makeSourceAuthorId(),
      authorName: 'GitHub Sync',
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const deps = createDeps({
      fetchFn,
      findSkillBySourceIdentity: jest.fn(async ({ upstreamId }) =>
        upstreamId === 'librechat-skills:skills/research' ? existing : null,
      ),
      listSkillsBySource: jest.fn(async () => [existing]),
      getSkillById: jest.fn(async (id) =>
        id.toString() === existing._id.toString() ? existing : null,
      ),
      updateSkill: jest.fn(async ({ update }) => ({
        status: 'updated' as const,
        skill: { ...existing, ...update, version: existing.version + 1 },
        warnings: [],
      })),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deps.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'research',
        sourceMetadata: expect.objectContaining({
          upstreamId: 'librechat-skills:skills/new',
        }),
      }),
    );
    expect(deps.updateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        id: existing._id.toString(),
        update: expect.objectContaining({
          name: 'renamed',
          sourceMetadata: expect.objectContaining({
            upstreamId: 'librechat-skills:skills/research',
          }),
        }),
      }),
    );
  });

  it('reuses a same-named source mirror when a skill moves configured paths', async () => {
    const existing = makeSkill({
      name: 'research',
      description: 'Old description',
      author: makeSourceAuthorId(),
      authorName: 'GitHub Sync',
      frontmatter: {},
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/old-research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/old-research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const unchangedFile = makeSkillFile(existing, {
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/old-research',
        commitSha: 'old-commit-sha',
        blobSha: 'file-sha',
        path: 'skills/old-research/scripts/run.sh',
      },
    });
    const deps = createDeps({
      findSkillBySourceIdentity: jest.fn(async () => null),
      listSkillsBySource: jest.fn(async () => [existing]),
      getSkillById: jest.fn(async () => existing),
      getSkillFileByPath: jest.fn(async () => unchangedFile),
      listSkillFiles: jest.fn(async () => [unchangedFile]),
      updateSkill: jest.fn(async ({ update }) => {
        Object.assign(existing, update, { version: existing.version + 1 });
        return { status: 'updated' as const, skill: existing, warnings: [] };
      }),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deps.createSkill).not.toHaveBeenCalled();
    expect(deps.updateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        id: existing._id.toString(),
        update: expect.objectContaining({
          sourceMetadata: expect.objectContaining({
            upstreamId: 'librechat-skills:skills/research',
            skillPath: 'skills/research',
          }),
        }),
      }),
    );
    expect(deps.deleteSkill).not.toHaveBeenCalled();
  });

  it('fails the source when skill rollback reports incomplete cleanup', async () => {
    /* A clean rollback is just a skipped skill. A failed one leaves the mirror
       inconsistent, which must not be reported as a partial success next to
       the skills that did publish. */
    const deps = createDeps({
      saveBuffer: jest.fn(async () => {
        throw new Error('storage unavailable');
      }),
      deleteSkill: jest.fn(async () => incompleteSkillDeletion(['permissions'])),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'SYNC_ROLLBACK_FAILED',
        errorMessage: expect.stringContaining('storage unavailable'),
      }),
    );
  });

  it('fails the source when rollback cannot remove a stored skill file', async () => {
    const storedFiles: Array<ISkillFile & { _id: Types.ObjectId }> = [];
    const deleteFile = jest.fn(async () => {
      throw new Error('storage cleanup unavailable');
    });
    const deleteSkill = jest.fn(async () => completeSkillDeletion(true));
    const deps = createDeps({
      listSkillFiles: jest.fn(async () => storedFiles),
      upsertSkillFile: jest.fn(async (input: UpsertSkillFileInput) => {
        const file = { ...input, _id: new Types.ObjectId() } as ISkillFile & {
          _id: Types.ObjectId;
        };
        storedFiles.push(file);
        return file;
      }),
      grantPermission: jest.fn(async () => {
        throw new Error('permission unavailable');
      }),
      deleteFile,
      deleteSkill,
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deleteSkill).toHaveBeenCalledTimes(1);
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'SYNC_ROLLBACK_FAILED',
        errorMessage: 'Rollback failed after: permission unavailable',
      }),
    );
  });

  it('fails the source when an unpersisted upload cannot be cleaned up', async () => {
    const deleteFile = jest.fn(async () => {
      throw new Error('orphan cleanup unavailable');
    });
    const deps = createDeps({
      upsertSkillFile: jest.fn(async () => {
        throw new Error('database unavailable');
      }),
      deleteFile,
    });

    const result = await createGitHubSkillSyncRunner(deps).runOnce();

    expect(result.status).toBe('failed');
    expect(deleteFile).toHaveBeenCalledTimes(1);
    expect(deps.deleteSkill).toHaveBeenCalledTimes(1);
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'SYNC_ROLLBACK_FAILED',
        errorMessage: 'Rollback failed after: database unavailable',
      }),
    );
  });

  it('keeps a moved skill mirror when the name it moves into turns out to be duplicated', async () => {
    /* Both discovered paths claim the same name, so neither publishes. The
       mirror the move would have reused is still live and must survive. */
    const existing = makeSkill({
      name: 'duplicate',
      description: 'Old description',
      author: makeSourceAuthorId(),
      authorName: 'GitHub Sync',
      frontmatter: {},
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/old-duplicate',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/old-duplicate',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const deps = createDeps({
      fetchFn: multiSkillFetch([
        { dir: 'first', markdown: '---\nname: duplicate\ndescription: First\n---\nBody' },
        { dir: 'second', markdown: '---\nname: duplicate\ndescription: Second\n---\nBody' },
      ]),
      findSkillBySourceIdentity: jest.fn(async () => null),
      listSkillsBySource: jest.fn(async () => [existing]),
      getSkillById: jest.fn(async () => existing),
      updateSkill: jest.fn(),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.createSkill).not.toHaveBeenCalled();
    expect(deps.deleteSkill).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ deletedSkillCount: 0, skippedSkillCount: 2 }),
    );
  });

  it('keeps a moved and renamed mirror when duplicate replacements are skipped', async () => {
    const existing = makeSkill({
      name: 'old-research',
      description: 'Last known good description',
      author: makeSourceAuthorId(),
      authorName: 'GitHub Sync',
      frontmatter: {},
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/old-research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/old-research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const deps = createDeps({
      fetchFn: multiSkillFetch([
        { dir: 'first', markdown: '---\nname: duplicate\ndescription: First\n---\nBody' },
        { dir: 'second', markdown: '---\nname: duplicate\ndescription: Second\n---\nBody' },
      ]),
      findSkillBySourceIdentity: jest.fn(async () => null),
      listSkillsBySource: jest.fn(async () => [existing]),
    });

    const result = await createGitHubSkillSyncRunner(deps).runOnce();

    expect(result.status).toBe('failed');
    expect(deps.createSkill).not.toHaveBeenCalled();
    expect(deps.deleteSkill).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ deletedSkillCount: 0, skippedSkillCount: 2 }),
    );
  });

  it('keeps a moved skill mirror when its move fails part way through', async () => {
    /* The mirror still carries the old upstream id until the update lands, so
       a failed move must not leave the reconcile pass reading it as stale. */
    const existing = makeSkill({
      name: 'research',
      description: 'Old description',
      author: makeSourceAuthorId(),
      authorName: 'GitHub Sync',
      frontmatter: {},
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/old-research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/old-research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const deps = createDeps({
      findSkillBySourceIdentity: jest.fn(async () => null),
      listSkillsBySource: jest.fn(async () => [existing]),
      getSkillById: jest.fn(async () => existing),
      listSkillFiles: jest.fn(async () => []),
      getSkillFileByPath: jest.fn(async () => null),
      saveBuffer: jest.fn(async () => {
        throw new Error('storage unavailable');
      }),
      updateSkill: jest.fn(),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.deleteSkill).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ deletedSkillCount: 0, skippedSkillCount: 1 }),
    );
  });

  it('keeps a moved and renamed mirror when its replacement fails after preparation', async () => {
    const existing = makeSkill({
      name: 'old-research',
      description: 'Last known good description',
      author: makeSourceAuthorId(),
      authorName: 'GitHub Sync',
      frontmatter: {},
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/old-research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/old-research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    let createdSkill: (ISkill & { _id: Types.ObjectId }) | undefined;
    const deleteSkill = jest.fn(async () => completeSkillDeletion(true));
    const deps = createDeps({
      fetchFn: githubFetch(
        '---\nname: renamed-research\ndescription: Renamed research skill\n---\nBody',
      ),
      findSkillBySourceIdentity: jest.fn(async () => null),
      listSkillsBySource: jest.fn(async () => [existing]),
      createSkill: jest.fn(async (input: CreateSkillInput): Promise<CreateSkillResult> => {
        createdSkill = makeSkill(input);
        return { skill: createdSkill, warnings: [] };
      }),
      saveBuffer: jest.fn(async () => {
        throw new Error('storage unavailable');
      }),
      deleteSkill,
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(createdSkill).toBeDefined();
    expect(deleteSkill).toHaveBeenCalledWith(createdSkill!._id.toString());
    expect(deleteSkill).not.toHaveBeenCalledWith(existing._id.toString());
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ deletedSkillCount: 0, skippedSkillCount: 1 }),
    );
  });

  it('refreshes an existing skill version after file sync before updating metadata', async () => {
    const existing = makeSkill({
      name: 'research',
      description: 'Old description',
      author: new Types.ObjectId(),
      authorName: 'GitHub Sync',
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const afterFileSync = { ...existing, version: existing.version + 2 };
    const deps = createDeps({
      findSkillBySourceIdentity: jest.fn(async () => existing),
      getSkillById: jest.fn(async () => afterFileSync),
      updateSkill: jest.fn(async ({ expectedVersion, update }) => ({
        status: 'updated' as const,
        skill: {
          ...afterFileSync,
          ...update,
          version: expectedVersion + 1,
        },
        warnings: [],
      })),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deps.upsertSkillFile).toHaveBeenCalled();
    expect(deps.getSkillById).toHaveBeenCalledWith(existing._id);
    expect(deps.updateSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        id: existing._id.toString(),
        expectedVersion: afterFileSync.version,
      }),
    );
  });

  it('treats frontmatter-only edits during sync as conflicts', async () => {
    const existing = makeSkill({
      name: 'research',
      description: 'Old description',
      body: 'Old body',
      frontmatter: { 'allowed-tools': ['old-tool'] },
      author: new Types.ObjectId(),
      authorName: 'GitHub Sync',
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const edited = {
      ...existing,
      version: existing.version + 1,
      frontmatter: { 'allowed-tools': ['user-tool'] },
    };
    const deps = createDeps({
      findSkillBySourceIdentity: jest.fn(async () => existing),
      getSkillById: jest.fn(async () => edited),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.upsertSkillFile).not.toHaveBeenCalled();
    expect(deps.updateSkill).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'SKILL_CONFLICT',
      }),
    );
  });

  it('skips existing skill updates when the upstream package is unchanged', async () => {
    const skillMarkdown = '---\nname: research\ndescription: Research things\n---\nBody';
    const existing = makeSkill({
      name: 'research',
      description: 'Research things',
      body: skillMarkdown,
      frontmatter: {},
      author: new Types.ObjectId(),
      authorName: 'GitHub Sync',
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/research',
        commitSha: 'old-commit-sha',
        skillBlobSha: 'skill-md-sha',
        syncedAt: '2026-05-30T00:00:00.000Z',
        syncStatus: 'synced',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const unchangedFile = makeSkillFile(existing, {
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/research',
        commitSha: 'old-commit-sha',
        blobSha: 'file-sha',
        path: 'skills/research/scripts/run.sh',
      },
    });
    const deps = createDeps({
      fetchFn: githubFetch(skillMarkdown),
      findSkillBySourceIdentity: jest.fn(async () => existing),
      getSkillById: jest.fn(async () => existing),
      getSkillFileByPath: jest.fn(async () => unchangedFile),
      listSkillFiles: jest.fn(async () => [unchangedFile]),
      updateSkill: jest.fn(),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('completed');
    expect(deps.saveBuffer).not.toHaveBeenCalled();
    expect(deps.upsertSkillFile).not.toHaveBeenCalled();
    expect(deps.updateSkill).not.toHaveBeenCalled();
    expect(deps.grantPermission).toHaveBeenCalled();
  });

  it('does not mutate existing skill files when permission grant fails', async () => {
    const existing = makeSkill({
      name: 'research',
      description: 'Old description',
      body: 'Old body',
      author: new Types.ObjectId(),
      authorName: 'GitHub Sync',
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const deps = createDeps({
      findSkillBySourceIdentity: jest.fn(async () => existing),
      getSkillById: jest.fn(async () => existing),
      grantPermission: jest.fn(async () => {
        throw new Error('permission unavailable');
      }),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.grantPermission).toHaveBeenCalledWith(
      expect.objectContaining({ resourceId: existing._id }),
    );
    expect(deps.listSkillFiles).not.toHaveBeenCalled();
    expect(deps.saveBuffer).not.toHaveBeenCalled();
    expect(deps.upsertSkillFile).not.toHaveBeenCalled();
    expect(deps.updateSkill).not.toHaveBeenCalled();
  });

  it('restores existing skill files when the skill update fails after file sync', async () => {
    const existing = makeSkill({
      name: 'research',
      description: 'Old description',
      body: 'Old body',
      author: new Types.ObjectId(),
      authorName: 'GitHub Sync',
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const oldFile = makeSkillFile(existing);
    const files = new Map<string, ISkillFile & { _id: Types.ObjectId }>([
      [oldFile.relativePath, oldFile],
    ]);
    const upsertSkillFile = jest.fn(
      async (
        row: Parameters<GitHubSkillSyncDeps['upsertSkillFile']>[0],
      ): Promise<ISkillFile & { _id: Types.ObjectId }> => {
        const current = files.get(row.relativePath);
        const next = {
          _id: current?._id ?? new Types.ObjectId(),
          skillId: row.skillId as Types.ObjectId,
          relativePath: row.relativePath,
          file_id: row.file_id,
          filename: row.filename,
          filepath: row.filepath,
          storageKey: row.storageKey,
          storageRegion: row.storageRegion,
          source: row.source,
          sourceMetadata: row.sourceMetadata,
          mimeType: row.mimeType,
          bytes: row.bytes,
          category: 'script' as const,
          isExecutable: row.isExecutable ?? false,
          author: new Types.ObjectId(row.author),
          tenantId: row.tenantId,
        };
        files.set(row.relativePath, next);
        return next;
      },
    );
    const deps = createDeps({
      findSkillBySourceIdentity: jest.fn(async () => existing),
      getSkillById: jest.fn(async () => ({ ...existing, version: existing.version + 1 })),
      getSkillFileByPath: jest.fn(
        async (_skillId, relativePath) => files.get(relativePath) ?? null,
      ),
      listSkillFiles: jest.fn(async () => Array.from(files.values())),
      upsertSkillFile,
      deleteSkillFile: jest.fn(async (_skillId, relativePath) => ({
        deleted: files.delete(relativePath),
      })),
      saveBuffer: jest.fn(async () => ({
        filepath: '/uploads/new-file-id__run.sh',
        source: 'local',
      })),
      deleteFile: jest.fn(async () => undefined),
      updateSkill: jest.fn(async () => ({ status: 'conflict' as const, current: existing })),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'SKILL_CONFLICT',
      }),
    );
    expect(files.get('scripts/run.sh')).toEqual(
      expect.objectContaining({ filepath: oldFile.filepath }),
    );
    expect(deps.deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ filepath: '/uploads/new-file-id__run.sh' }),
    );
    expect(deps.deleteFile).not.toHaveBeenCalledWith(
      expect.objectContaining({ filepath: oldFile.filepath }),
    );
  });

  it('fails the source when existing-skill rollback cannot remove replacement storage', async () => {
    const existing = makeSkill({
      name: 'research',
      description: 'Old description',
      body: 'Old body',
      author: new Types.ObjectId(),
      authorName: 'GitHub Sync',
      source: 'github',
      sourceMetadata: {
        provider: 'github',
        sourceId: 'librechat-skills',
        upstreamId: 'librechat-skills:skills/research',
        owner: 'LibreChat',
        repo: 'skills',
        ref: 'main',
        skillPath: 'skills/research',
      },
    }) as ISkill & { _id: Types.ObjectId };
    const oldFile = makeSkillFile(existing);
    const deleteFile = jest.fn(async () => {
      throw new Error('replacement cleanup unavailable');
    });
    const deps = createDeps({
      findSkillBySourceIdentity: jest.fn(async () => existing),
      getSkillById: jest.fn(async () => ({ ...existing, version: existing.version + 1 })),
      getSkillFileByPath: jest.fn(async () => oldFile),
      listSkillFiles: jest.fn(async () => [oldFile]),
      upsertSkillFile: jest.fn(async (row) => ({
        ...oldFile,
        ...row,
        _id: oldFile._id,
        skillId: row.skillId as Types.ObjectId,
        author: new Types.ObjectId(row.author),
      })),
      saveBuffer: jest.fn(async () => ({
        filepath: '/uploads/new-file-id__run.sh',
        source: 'local',
      })),
      deleteFile,
      updateSkill: jest.fn(async () => ({ status: 'conflict' as const, current: existing })),
    });

    const result = await createGitHubSkillSyncRunner(deps).runOnce();

    expect(result.status).toBe('failed');
    expect(deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({ filepath: '/uploads/new-file-id__run.sh' }),
    );
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'SYNC_ROLLBACK_FAILED',
        errorMessage: 'Rollback failed after: Skill "research" changed during sync',
      }),
    );
  });

  it('preserves credential presence when a manual run is skipped by an active lock', async () => {
    const deps = createDeps({
      tryAcquireLock: jest.fn(async () => false),
      listCredentials: jest.fn(async () => [
        {
          provider: 'github' as const,
          credentialKey: 'github-skills-prod',
          credentialPresent: true,
          tokenFingerprint: 'abc123',
        },
      ]),
      listStatuses: jest.fn(async () => [
        {
          provider: 'github',
          sourceId: 'librechat-skills',
          status: 'running',
          credentialKey: 'github-skills-prod',
          owner: 'LibreChat',
          repo: 'skills',
          ref: 'main',
          paths: ['skills'],
          syncedSkillCount: 0,
          syncedFileCount: 0,
          deletedSkillCount: 0,
          deletedFileCount: 0,
        } as ISkillSyncStatus,
      ]),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('skipped');
    expect(result.sources).toEqual([
      expect.objectContaining({
        sourceId: 'librechat-skills',
        status: 'running',
        credentialPresent: true,
      }),
    ]);
  });

  it('uses a fresh lock owner for each sync run', async () => {
    const deps = createDeps({ lockOwner: 'worker-a' });
    const runner = createGitHubSkillSyncRunner(deps);

    await runner.runOnce();
    await runner.runOnce();

    const lockOwners = (deps.tryAcquireLock as jest.Mock).mock.calls.map(
      ([params]: [Parameters<GitHubSkillSyncDeps['tryAcquireLock']>[0]]) => params.lockOwner,
    );
    const releasedOwners = (deps.releaseLock as jest.Mock).mock.calls.map(
      ([params]: [Parameters<GitHubSkillSyncDeps['releaseLock']>[0]]) => params.lockOwner,
    );

    expect(lockOwners).toHaveLength(2);
    expect(lockOwners[0]).not.toBe(lockOwners[1]);
    expect(lockOwners.every((owner) => owner.startsWith('worker-a:'))).toBe(true);
    expect(releasedOwners).toEqual(lockOwners);
  });

  it('excludes child skill packages from parent synced files', async () => {
    const parentSkillMarkdown = '---\nname: parent\ndescription: Parent skill\n---\nParent';
    const childSkillMarkdown = '---\nname: child\ndescription: Child skill\n---\nChild';
    const fetchFn = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/commits/')) {
        return response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } });
      }
      if (url.includes('/git/trees/tree-sha')) {
        return response({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            {
              path: 'skills',
              mode: '040000',
              type: 'tree',
              sha: 'skills-tree-sha',
              url: 'https://api.github.test/tree/skills',
            },
          ],
        });
      }
      if (url.includes('/git/trees/skills-tree-sha')) {
        return response({
          sha: 'skills-tree-sha',
          truncated: false,
          tree: [
            {
              path: 'SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'parent-skill-sha',
              size: Buffer.byteLength(parentSkillMarkdown),
              url: 'https://api.github.test/blob/parent-skill',
            },
            {
              path: 'parent.txt',
              mode: '100644',
              type: 'blob',
              sha: 'parent-file-sha',
              size: 6,
              url: 'https://api.github.test/blob/parent-file',
            },
            {
              path: 'child/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'child-skill-sha',
              size: Buffer.byteLength(childSkillMarkdown),
              url: 'https://api.github.test/blob/child-skill',
            },
            {
              path: 'child/child.txt',
              mode: '100644',
              type: 'blob',
              sha: 'child-file-sha',
              size: 5,
              url: 'https://api.github.test/blob/child-file',
            },
          ],
        });
      }
      if (url.includes('/git/blobs/parent-skill-sha')) {
        return response(blob(parentSkillMarkdown));
      }
      if (url.includes('/git/blobs/parent-file-sha')) {
        return response(blob('parent'));
      }
      if (url.includes('/git/blobs/child-skill-sha')) {
        return response(blob(childSkillMarkdown));
      }
      if (url.includes('/git/blobs/child-file-sha')) {
        return response(blob('child'));
      }
      return response({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    const deps = createDeps({ fetchFn });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();
    const fileCalls = (deps.upsertSkillFile as jest.Mock).mock.calls.map(
      ([row]: [Parameters<GitHubSkillSyncDeps['upsertSkillFile']>[0]]) => row,
    );

    expect(result.status).toBe('completed');
    expect(fileCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'parent.txt',
          sourceMetadata: expect.objectContaining({
            upstreamId: 'librechat-skills:skills',
          }),
        }),
        expect.objectContaining({
          relativePath: 'child.txt',
          sourceMetadata: expect.objectContaining({
            upstreamId: 'librechat-skills:skills/child',
          }),
        }),
      ]),
    );
    expect(fileCalls).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          relativePath: 'child/SKILL.md',
          sourceMetadata: expect.objectContaining({
            upstreamId: 'librechat-skills:skills',
          }),
        }),
        expect.objectContaining({
          relativePath: 'child/child.txt',
          sourceMetadata: expect.objectContaining({
            upstreamId: 'librechat-skills:skills',
          }),
        }),
      ]),
    );
  });

  it('rejects oversized GitHub blobs before downloading file content', async () => {
    const skillMarkdown = '---\nname: research\ndescription: Research things\n---\nBody';
    const oversizedBytes = DEFAULT_SKILL_IMPORT_LIMITS.maxSingleFileBytes + 1;
    const fetchFn = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/commits/')) {
        return response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } });
      }
      if (url.includes('/git/trees/tree-sha')) {
        return response({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            {
              path: 'skills',
              mode: '040000',
              type: 'tree',
              sha: 'skills-tree-sha',
              url: 'https://api.github.test/tree/skills',
            },
          ],
        });
      }
      if (url.includes('/git/trees/skills-tree-sha')) {
        return response({
          sha: 'skills-tree-sha',
          truncated: false,
          tree: [
            {
              path: 'research/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'skill-md-sha',
              size: Buffer.byteLength(skillMarkdown),
              url: 'https://api.github.test/blob/skill',
            },
            {
              path: 'research/data.bin',
              mode: '100644',
              type: 'blob',
              sha: 'oversized-file-sha',
              size: oversizedBytes,
              url: 'https://api.github.test/blob/oversized',
            },
          ],
        });
      }
      if (url.includes('/git/blobs/skill-md-sha')) {
        return response(blob(skillMarkdown));
      }
      if (url.includes('/git/blobs/oversized-file-sha')) {
        throw new Error('oversized blob should not be downloaded');
      }
      return response({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    const deps = createDeps({ fetchFn });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();
    const fetchedUrls = (fetchFn as unknown as jest.Mock).mock.calls.map(
      ([input]: [RequestInfo | URL]) => input.toString(),
    );

    expect(result.status).toBe('failed');
    expect(fetchedUrls.some((url) => url.includes('/git/blobs/oversized-file-sha'))).toBe(false);
    expect(deps.createSkill).not.toHaveBeenCalled();
    expect(deps.saveBuffer).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'GITHUB_BLOB_TOO_LARGE',
      }),
    );
  });

  it('rejects packages that exceed the skill import entry limit before blob downloads', async () => {
    const skillMarkdown = '---\nname: research\ndescription: Research things\n---\nBody';
    const extraFiles = Array.from(
      { length: DEFAULT_SKILL_IMPORT_LIMITS.maxEntries },
      (_, index) => ({
        path: `research/files/${index}.txt`,
        mode: '100644',
        type: 'blob',
        sha: `file-${index}-sha`,
        size: 1,
        url: `https://api.github.test/blob/file-${index}`,
      }),
    );
    const fetchFn = jest.fn(async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes('/commits/')) {
        return response({ sha: 'commit-sha', commit: { tree: { sha: 'tree-sha' } } });
      }
      if (url.includes('/git/trees/tree-sha')) {
        return response({
          sha: 'tree-sha',
          truncated: false,
          tree: [
            {
              path: 'skills',
              mode: '040000',
              type: 'tree',
              sha: 'skills-tree-sha',
              url: 'https://api.github.test/tree/skills',
            },
          ],
        });
      }
      if (url.includes('/git/trees/skills-tree-sha')) {
        return response({
          sha: 'skills-tree-sha',
          truncated: false,
          tree: [
            {
              path: 'research/SKILL.md',
              mode: '100644',
              type: 'blob',
              sha: 'skill-md-sha',
              size: Buffer.byteLength(skillMarkdown),
              url: 'https://api.github.test/blob/skill',
            },
            ...extraFiles,
          ],
        });
      }
      if (url.includes('/git/blobs/')) {
        throw new Error('blob should not be downloaded');
      }
      return response({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    const deps = createDeps({ fetchFn });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.createSkill).not.toHaveBeenCalled();
    expect(deps.saveBuffer).not.toHaveBeenCalled();
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'failed',
        errorCode: 'GITHUB_TOO_MANY_FILES',
      }),
    );
  });

  it('rolls back a newly created skill when file sync fails before publishing', async () => {
    const deps = createDeps({
      saveBuffer: jest.fn(async () => {
        throw new Error('storage unavailable');
      }),
    });
    const runner = createGitHubSkillSyncRunner(deps);
    const result = await runner.runOnce();

    expect(result.status).toBe('failed');
    expect(deps.createSkill).toHaveBeenCalled();
    expect(deps.grantPermission).not.toHaveBeenCalled();
    expect(deps.upsertSkillFile).not.toHaveBeenCalled();
    expect(deps.deleteSkill).toHaveBeenCalledWith(expect.any(String));
  });

  it('stops syncing after losing the Mongo lock lease', async () => {
    jest.useFakeTimers();
    let releaseToken: (token: string) => void = () => undefined;
    const tokenPromise = new Promise<string>((resolve) => {
      releaseToken = resolve;
    });
    const deps = createDeps({
      getCredentialToken: jest.fn(() => tokenPromise),
      refreshLock: jest.fn(async () => false),
    });
    const runner = createGitHubSkillSyncRunner(deps);

    try {
      const runPromise = runner.runOnce();
      await jest.advanceTimersByTimeAsync(10 * 60 * 1000);
      releaseToken('github_pat_secret');
      const result = await runPromise;

      expect(result.status).toBe('failed');
      expect(result.message).toBe('GitHub skill sync lock was lost');
      expect(deps.fetchFn).not.toHaveBeenCalled();
      expect(deps.upsertStatus).toHaveBeenLastCalledWith(
        expect.objectContaining({
          status: 'failed',
          errorCode: 'SYNC_LOCK_LOST',
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });
});

/** Stands in for any provider: a flat repository held in memory. */
function createFakeAdapter(files: Record<string, string>): GitRepoAdapter {
  const entries: RepoTreeEntry[] = Object.entries(files).map(([path, content]) => ({
    path,
    type: 'blob',
    id: `${path}@1`,
    size: Buffer.byteLength(content),
  }));
  return {
    resolveCommit: async () => ({ id: 'fake-commit', treeId: 'fake-tree' }),
    fetchTreeEntries: async (_commit, { pathPrefix }) =>
      entries.filter((entry) => !pathPrefix || entry.path.startsWith(`${pathPrefix}/`)),
    fetchFileContent: async (_commit, entry) => Buffer.from(files[entry.path]),
  };
}

describe('repository adapter seam', () => {
  it('publishes skills read through any repository client, with no provider requests', async () => {
    const deps = createDeps({
      createAdapter: () =>
        createFakeAdapter({
          'skills/research/SKILL.md':
            '---\nname: research\ndescription: Research things\n---\nBody',
          'skills/research/scripts/run.sh': 'echo hi',
        }),
    });

    const result = await createGitHubSkillSyncRunner(deps).runOnce();

    expect(result.status).toBe('completed');
    expect(deps.fetchFn).not.toHaveBeenCalled();
    expect(deps.createSkill).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'research',
        sourceMetadata: expect.objectContaining({
          commitSha: 'fake-commit',
          skillBlobSha: 'skills/research/SKILL.md@1',
        }),
      }),
    );
    expect(deps.upsertSkillFile).toHaveBeenCalledWith(
      expect.objectContaining({
        relativePath: 'scripts/run.sh',
        sourceMetadata: expect.objectContaining({
          commitSha: 'fake-commit',
          blobSha: 'skills/research/scripts/run.sh@1',
        }),
      }),
    );
  });

  it('re-downloads a file only when the adapter reports a new content id', async () => {
    const deps = createDeps({
      createAdapter: () =>
        createFakeAdapter({
          'skills/research/SKILL.md':
            '---\nname: research\ndescription: Research things\n---\nBody',
          'skills/research/scripts/run.sh': 'echo hi',
        }),
      getSkillFileByPath: jest.fn(async () => ({
        _id: new Types.ObjectId(),
        skillId: new Types.ObjectId(),
        relativePath: 'scripts/run.sh',
        file_id: 'existing-file-id',
        filename: 'run.sh',
        filepath: '/uploads/existing-file-id__run.sh',
        source: 'local',
        sourceMetadata: { blobSha: 'skills/research/scripts/run.sh@1' },
        mimeType: 'application/x-sh',
        bytes: 7,
        category: 'script' as const,
        isExecutable: false,
        author: new Types.ObjectId(),
        createdAt: new Date(),
        updatedAt: new Date(),
      })),
    });

    const result = await createGitHubSkillSyncRunner(deps).runOnce();

    expect(result.status).toBe('completed');
    expect(deps.upsertSkillFile).not.toHaveBeenCalled();
  });
});

describe('files whose paths cannot be mirrored', () => {
  const skillMarkdown = '---\nname: research\ndescription: Research things\n---\nBody';

  it('publishes the skill but reports the run partial and names the dropped file', async () => {
    const deps = createDeps({
      createAdapter: () =>
        createFakeAdapter({
          'skills/research/SKILL.md': skillMarkdown,
          'skills/research/scripts/run.sh': 'echo hi',
          'skills/research/Skill Card Generator Card': 'card',
        }),
    });

    const result = await createGitHubSkillSyncRunner(deps).runOnce();

    expect(result.status).toBe('completed');
    expect(deps.createSkill).toHaveBeenCalledTimes(1);
    expect(deps.upsertSkillFile).toHaveBeenCalledWith(
      expect.objectContaining({ relativePath: 'scripts/run.sh' }),
    );
    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'partial',
        syncedSkillCount: 1,
        skippedSkillCount: 0,
        skippedFileCount: 1,
        skippedFiles: [
          {
            path: 'skills/research/Skill Card Generator Card',
            skillPath: 'skills/research',
            errorCode: 'SKILL_FILE_PATH_UNSUPPORTED',
            errorMessage: expect.stringContaining('cannot represent'),
          },
        ],
      }),
    );
  });

  it('never mirrors the unsupported file itself', async () => {
    const deps = createDeps({
      createAdapter: () =>
        createFakeAdapter({
          'skills/research/SKILL.md': skillMarkdown,
          'skills/research/Skill Card Generator Card': 'card',
        }),
    });

    await createGitHubSkillSyncRunner(deps).runOnce();

    expect(deps.upsertSkillFile).not.toHaveBeenCalled();
  });

  it('does not downgrade a source that mirrored everything it found', async () => {
    const deps = createDeps({
      createAdapter: () =>
        createFakeAdapter({
          'skills/research/SKILL.md': skillMarkdown,
          'skills/research/scripts/run.sh': 'echo hi',
        }),
    });

    await createGitHubSkillSyncRunner(deps).runOnce();

    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({ status: 'succeeded', skippedFileCount: 0 }),
    );
  });

  it('does not charge a dropped file to a skill that never published', async () => {
    const deps = createDeps({
      createAdapter: () =>
        createFakeAdapter({
          'skills/broken/SKILL.md': '---\nname: [\n---\nBody',
          'skills/broken/bad name': 'x',
          'skills/research/SKILL.md': skillMarkdown,
        }),
    });

    await createGitHubSkillSyncRunner(deps).runOnce();

    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        status: 'partial',
        skippedSkillCount: 1,
        skippedFileCount: 0,
      }),
    );
  });

  it('keeps the recorded sample for skills that published, not skills that were skipped', async () => {
    const files: Record<string, string> = {
      'skills/broken/SKILL.md': '---\nname: [\n---\nBody',
      'skills/research/SKILL.md': skillMarkdown,
      'skills/research/bad name': 'x',
    };
    for (let i = 0; i < 25; i++) {
      files[`skills/broken/bad name ${i}`] = 'x';
    }
    const deps = createDeps({ createAdapter: () => createFakeAdapter(files) });

    await createGitHubSkillSyncRunner(deps).runOnce();

    const statusCalls = (deps.upsertStatus as jest.Mock).mock.calls;
    const status = statusCalls[statusCalls.length - 1][0] as SkillSyncStatusInput;
    expect(status.skippedFileCount).toBe(1);
    expect(status.skippedFiles).toEqual([
      expect.objectContaining({ path: 'skills/research/bad name', skillPath: 'skills/research' }),
    ]);
  });

  it('keeps counting past the recorded sample so the total stays truthful', async () => {
    const files: Record<string, string> = { 'skills/research/SKILL.md': skillMarkdown };
    for (let i = 0; i < 25; i++) {
      files[`skills/research/bad name ${i}`] = 'x';
    }
    const deps = createDeps({ createAdapter: () => createFakeAdapter(files) });

    await createGitHubSkillSyncRunner(deps).runOnce();

    const statusCalls = (deps.upsertStatus as jest.Mock).mock.calls;
    const status = statusCalls[statusCalls.length - 1][0] as SkillSyncStatusInput;
    expect(status.skippedFileCount).toBe(25);
    expect(status.skippedFiles).toHaveLength(20);
  });

  it('records an empty skill path for a skill mirrored from the repository root', async () => {
    const deps = createDeps({
      getConfig: () => ({
        github: {
          enabled: true,
          intervalMinutes: 60,
          runOnStartup: false,
          sources: [
            {
              id: 'librechat-skills',
              owner: 'LibreChat',
              repo: 'skills',
              ref: 'main',
              paths: [''],
              credentialKey: 'github-skills-prod',
            },
          ],
        },
      }),
      createAdapter: () => createFakeAdapter({ 'SKILL.md': skillMarkdown, 'bad name': 'x' }),
    });

    await createGitHubSkillSyncRunner(deps).runOnce();

    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        skippedFileCount: 1,
        skippedFiles: [expect.objectContaining({ path: 'bad name', skillPath: '' })],
      }),
    );
  });

  it('attributes a dropped file to the nested skill that owns it', async () => {
    const deps = createDeps({
      createAdapter: () =>
        createFakeAdapter({
          'skills/research/SKILL.md': skillMarkdown,
          'skills/research/nested/SKILL.md':
            '---\nname: nested\ndescription: Nested things\n---\nBody',
          'skills/research/nested/bad name': 'x',
        }),
    });

    await createGitHubSkillSyncRunner(deps).runOnce();

    expect(deps.upsertStatus).toHaveBeenLastCalledWith(
      expect.objectContaining({
        skippedFileCount: 1,
        skippedFiles: [expect.objectContaining({ skillPath: 'skills/research/nested' })],
      }),
    );
  });
});
