jest.mock('@librechat/data-schemas', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

const mockExtract = jest.fn();
jest.mock('./run', () => ({
  extractInvokedSkillsFromPayload: (...args: unknown[]) => mockExtract(...args),
}));

import { Readable } from 'stream';
import { Types } from 'mongoose';
import { createCodeApiUploadRegistry } from '~/utils';
import { primeInvokedSkills, primeInvokedSkillsForProfiles, primeSkillFiles } from './skillFiles';
import type {
  PrimeInvokedSkillsDeps,
  PrimeInvokedSkillsForProfilesDeps,
  PrimeSkillFilesParams,
} from './skillFiles';

const SKILL_ID = new Types.ObjectId();
const SKILL_VERSION = 7;
const uploadRegistry = createCodeApiUploadRegistry();

function makeDeps(overrides: Partial<PrimeInvokedSkillsDeps> = {}): PrimeInvokedSkillsDeps {
  const listSkillFiles = jest.fn().mockResolvedValue([]);
  const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
    storage_session_id: 'session-x',
    files: [],
  });
  return {
    req: {
      user: { id: 'user-1', tenantId: 'tenant-1' },
      app: { locals: { codeApiUploadRegistry: uploadRegistry } },
    } as unknown as PrimeInvokedSkillsDeps['req'],
    payload: [{ role: 'assistant', content: [] }],
    accessibleSkillIds: [SKILL_ID],
    codeEnvAvailable: true,
    getSkillByName: jest.fn().mockResolvedValue({
      _id: SKILL_ID,
      name: 'brand-guidelines',
      body: 'skill body',
      version: SKILL_VERSION,
      fileCount: 2,
    }),
    listSkillFiles,
    getStrategyFunctions: jest.fn(),
    batchUploadCodeEnvFiles,
    ...overrides,
  };
}

describe('primeInvokedSkills — execute_code capability gate', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExtract.mockReturnValue(new Set(['brand-guidelines']));
  });

  it('skips the batch-upload path when codeEnvAvailable is false', async () => {
    const deps = makeDeps({ codeEnvAvailable: false });

    const result = await primeInvokedSkills(deps);

    expect(result.skills?.get('brand-guidelines')).toBe('skill body');
    expect(deps.listSkillFiles).not.toHaveBeenCalled();
    expect(deps.batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('resolves explicit actor-head names without scanning message history', async () => {
    mockExtract.mockReturnValue(new Set());
    const deps = makeDeps({ payload: undefined, skillNames: ['brand-guidelines'] });

    const result = await primeInvokedSkills(deps);

    expect(deps.getSkillByName).toHaveBeenCalledWith('brand-guidelines', [SKILL_ID]);
    expect(result.skillManifest).toEqual([
      {
        id: SKILL_ID.toString(),
        name: 'brand-guidelines',
        version: SKILL_VERSION,
        contentDigest: expect.any(String),
      },
    ]);
  });

  it('enters the batch-upload path when codeEnvAvailable is true', async () => {
    const deps = makeDeps({ codeEnvAvailable: true });

    await primeInvokedSkills(deps);

    expect(deps.listSkillFiles).toHaveBeenCalledWith(SKILL_ID);
  });

  it('shares one retry-wait budget across historical skill uploads', async () => {
    const skillIds = [new Types.ObjectId(), new Types.ObjectId()];
    const skillNames = ['first-skill', 'second-skill'];
    mockExtract.mockReturnValue(new Set(skillNames));
    const getSkillByName = jest.fn(async (name: string) => {
      const index = skillNames.indexOf(name);
      return {
        _id: skillIds[index],
        name,
        body: `${name} body`,
        version: 1,
        fileCount: 1,
      };
    });
    const listSkillFiles = jest.fn(async () => [
      {
        relativePath: 'references/style.md',
        filename: 'style.md',
        filepath: '/storage/style.md',
        source: 's3',
        bytes: 5,
      },
    ]);
    const attempts = new Map<string, number>();
    const batchUploadCodeEnvFiles = jest.fn(async ({ id }: { id: string }) => {
      const attempt = (attempts.get(id) ?? 0) + 1;
      attempts.set(id, attempt);
      if (attempt === 1) {
        const error = new Error('Request failed with status code 429') as Error & {
          isAxiosError: boolean;
          response: { status: number; headers: Record<string, string> };
        };
        error.isAxiosError = true;
        error.response = { status: 429, headers: { 'retry-after': '0' } };
        throw error;
      }
      const name = skillNames[skillIds.findIndex((skillId) => skillId.toString() === id)];
      return {
        storage_session_id: `session-${name}`,
        files: [{ fileId: `file-${name}`, filename: `skills/${name}/references/style.md` }],
      };
    });
    const deps = makeDeps({
      getSkillByName,
      listSkillFiles,
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from('style'))),
      }),
      batchUploadCodeEnvFiles,
    });
    deps.req.config = {
      endpoints: { agents: { codeApiUploadConcurrency: 1, codeApiMaxRetryWaitMs: 1_000 } },
    } as never;

    const result = await primeInvokedSkills(deps);

    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(3);
    expect(result.initialSessions?.get('execute_code')?.files).toHaveLength(1);
  });

  it('calls batchUploadCodeEnvFiles without an apiKey when files are returned', async () => {
    const fileRecords = [
      {
        relativePath: 'references/style.md',
        filename: 'style.md',
        filepath: '/storage/brand-guidelines/references/style.md',
        source: 's3',
        bytes: 256,
      },
    ];
    const listSkillFiles = jest.fn().mockResolvedValue(fileRecords);
    const getStrategyFunctions = jest.fn().mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
    });
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'session-42',
      files: [{ fileId: 'file-1', filename: 'skills/brand-guidelines/references/style.md' }],
    });

    const deps = makeDeps({
      codeEnvAvailable: true,
      listSkillFiles,
      getStrategyFunctions,
      batchUploadCodeEnvFiles,
      codeExecutionContext: {
        baseUrl: 'https://stateful-code.example.com',
        executionProfile: 'stateful',
      },
    });

    await primeInvokedSkills(deps);

    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(1);
    const [uploadArgs] = batchUploadCodeEnvFiles.mock.calls[0];
    expect(uploadArgs).not.toHaveProperty('apiKey');
    expect(uploadArgs).not.toHaveProperty('entity_id');
    expect(uploadArgs.read_only).toBe(true);
    /* Resource identity for codeapi's sessionKey: skill files share
     * cross-user-within-tenant under `<tenant>:skill:<id>:v:<version>`.
     * Without these on the upload, codeapi falls back to user bucketing
     * and skill-cache invalidation (driven by version bump on edit)
     * never fires. See codeapi #1455 (option α). */
    expect(uploadArgs.kind).toBe('skill');
    expect(uploadArgs.id).toBe(SKILL_ID.toString());
    expect(uploadArgs.version).toBe(SKILL_VERSION);
    expect(uploadArgs.codeApiBaseUrl).toBe('https://stateful-code.example.com');
    expect(uploadArgs.executionProfile).toBe('stateful');
    expect(uploadArgs.files).toHaveLength(fileRecords.length + 1);
    expect(uploadArgs.files.map((f: { filename: string }) => f.filename)).toEqual(
      expect.arrayContaining([
        'skills/brand-guidelines/SKILL.md',
        'skills/brand-guidelines/references/style.md',
      ]),
    );
  });

  it('propagates a blocked historical bundle before reconstructing invoked skills', async () => {
    const protectedValue = 'sk-historical-prime-secret';
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            skills: {
              pii: {
                fields: ['file_text'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
        },
      } as PrimeInvokedSkillsDeps['req'],
      listSkillFiles: jest.fn().mockResolvedValue([
        {
          relativePath: 'references/private.md',
          filename: 'private.md',
          filepath: '/storage/brand-guidelines/references/private.md',
          source: 's3',
          bytes: protectedValue.length,
        },
      ]),
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(protectedValue))),
      }),
      batchUploadCodeEnvFiles,
    });

    await expect(primeInvokedSkills(deps)).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'skill', field: 'file_text' },
    });
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('re-inspects active cached file references after a policy is enabled', async () => {
    const protectedValue = 'sk-active-cached-secret';
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            skills: {
              pii: {
                fields: ['file_text'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
        },
      } as PrimeInvokedSkillsDeps['req'],
      listSkillFiles: jest.fn().mockResolvedValue([
        {
          relativePath: 'references/private.md',
          filename: 'private.md',
          filepath: '/storage/brand-guidelines/references/private.md',
          source: 's3',
          bytes: protectedValue.length,
          codeEnvRef: {
            kind: 'skill',
            id: SKILL_ID.toString(),
            storage_session_id: 'session-active',
            file_id: 'file-active',
            version: SKILL_VERSION,
          },
        },
      ]),
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(protectedValue))),
      }),
      batchUploadCodeEnvFiles,
      getSessionInfo: jest.fn().mockResolvedValue('2026-05-06T00:00:00Z'),
      checkIfActive: jest.fn().mockReturnValue(true),
    });

    await expect(primeInvokedSkills(deps)).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'skill', field: 'file_text' },
    });
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('reuses the aggregate active-session cache for metadata-only filters', async () => {
    const getStrategyFunctions = jest.fn();
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            files: {
              pii: {
                fields: ['name'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
        },
      } as PrimeInvokedSkillsDeps['req'],
      listSkillFiles: jest.fn().mockResolvedValue([
        {
          relativePath: 'references/style.md',
          filename: 'style.md',
          filepath: '/storage/brand-guidelines/references/style.md',
          source: 's3',
          bytes: 256,
          codeEnvRef: {
            kind: 'skill',
            id: SKILL_ID.toString(),
            storage_session_id: 'session-active',
            file_id: 'file-active',
            version: SKILL_VERSION,
          },
        },
      ]),
      getStrategyFunctions,
      batchUploadCodeEnvFiles,
      getSessionInfo: jest.fn().mockResolvedValue('2026-05-06T00:00:00Z'),
      checkIfActive: jest.fn().mockReturnValue(true),
    });

    const result = await primeInvokedSkills(deps);

    expect(getStrategyFunctions).not.toHaveBeenCalled();
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
    expect(result.initialSessions?.get('execute_code')?.files).toEqual([
      expect.objectContaining({
        id: 'file-active',
        name: 'skills/brand-guidelines/references/style.md',
      }),
    ]);
  });

  it('re-inspects invoked skill bodies that have no bundled files', async () => {
    const deps = makeDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            skills: {
              pii: {
                fields: ['instructions'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
        },
      } as PrimeInvokedSkillsDeps['req'],
      codeEnvAvailable: false,
      getSkillByName: jest.fn().mockResolvedValue({
        _id: SKILL_ID,
        name: 'brand-guidelines',
        body: 'historical sk-body-secret',
        version: SKILL_VERSION,
        fileCount: 0,
      }),
    });

    await expect(primeInvokedSkills(deps)).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'skill', field: 'instructions' },
    });
  });

  it('classifies the stored SKILL.md body as extracted file text', async () => {
    const deps = makeDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            files: {
              pii: {
                fields: ['extracted_text'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
        },
      } as PrimeInvokedSkillsDeps['req'],
      codeEnvAvailable: false,
      getSkillByName: jest.fn().mockResolvedValue({
        _id: SKILL_ID,
        name: 'brand-guidelines',
        body: 'historical sk-body-secret',
        version: SKILL_VERSION,
        fileCount: 0,
      }),
    });

    await expect(primeInvokedSkills(deps)).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'file', field: 'extracted_text' },
    });
  });

  it('returns {} early when no skills were invoked, regardless of capability', async () => {
    mockExtract.mockReturnValue(new Set());
    const deps = makeDeps({ codeEnvAvailable: true });

    const result = await primeInvokedSkills(deps);

    expect(result).toEqual({});
    expect(deps.getSkillByName).not.toHaveBeenCalled();
  });

  it('writes kind/version/storage_session_id on every cached file after a fresh upload', async () => {
    /* Per-file refs in `CodeSessionContext.files` carry the resource
     * identity (kind=skill, id=skillId, version=skill.version) so
     * codeapi can derive the right sessionKey. Cache scope is per
     * (tenant, kind, id, version) — bumping the skill version
     * naturally invalidates the prior cache. */
    const listSkillFiles = jest.fn().mockResolvedValue([
      {
        relativePath: 'references/style.md',
        filename: 'style.md',
        filepath: '/storage/brand-guidelines/references/style.md',
        source: 's3',
        bytes: 256,
      },
    ]);
    const getStrategyFunctions = jest.fn().mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
    });
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'session-42',
      files: [{ fileId: 'file-1', filename: 'skills/brand-guidelines/references/style.md' }],
    });

    const deps = makeDeps({
      codeEnvAvailable: true,
      listSkillFiles,
      getStrategyFunctions,
      batchUploadCodeEnvFiles,
    });

    const result = await primeInvokedSkills(deps);

    const codeSession = result.initialSessions?.get('execute_code');
    expect(codeSession?.files).toEqual([
      {
        id: 'file-1',
        /* `resource_id` is the skill `_id` — drives codeapi's
         * sessionKey re-derivation. Distinct from `id` (the storage
         * file_id). The split fixes the shared-kind 403 mismatch
         * where codeapi computed sessionKey from the storage nanoid
         * instead of the skill _id. */
        resource_id: SKILL_ID.toString(),
        name: 'skills/brand-guidelines/references/style.md',
        storage_session_id: 'session-42',
        kind: 'skill',
        version: SKILL_VERSION,
      },
    ]);
  });

  it('awaits updateSkillFileCodeEnvIds before resolving to avoid concurrent-prime cache misses', async () => {
    /* Concurrency regression: when many users hit the same skill at
     * once, fire-and-forget keeps the cache in miss-steady-state for
     * the burst — User N's prime reads SkillFile docs before User N-1's
     * persist commits, sees no codeEnvRef, re-uploads, and fires its
     * own forget that User N+1 also races. Awaiting the persist before
     * the prime resolves ensures the next concurrent caller observes
     * the cache pointer instead of racing a write. */
    const fileRecords = [
      {
        relativePath: 'references/style.md',
        filename: 'style.md',
        filepath: '/storage/brand-guidelines/references/style.md',
        source: 's3',
        bytes: 256,
      },
    ];
    const listSkillFiles = jest.fn().mockResolvedValue(fileRecords);
    const getStrategyFunctions = jest.fn().mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
    });
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'session-42',
      files: [{ fileId: 'file-1', filename: 'skills/brand-guidelines/references/style.md' }],
    });

    /* Defer resolution so we can assert the prime hasn't returned yet
     * — proves the call site is awaiting, not fire-and-forget. */
    let resolvePersist!: (v: { matchedCount: number; modifiedCount: number }) => void;
    const persistGate = new Promise<{ matchedCount: number; modifiedCount: number }>((r) => {
      resolvePersist = r;
    });
    const updateSkillFileCodeEnvIds = jest.fn().mockReturnValue(persistGate);

    const deps = makeDeps({
      codeEnvAvailable: true,
      listSkillFiles,
      getStrategyFunctions,
      batchUploadCodeEnvFiles,
      updateSkillFileCodeEnvIds,
    });

    let resolved = false;
    const primePromise = primeInvokedSkills(deps).then((r) => {
      resolved = true;
      return r;
    });

    /* Drain the microtask queue. The prime should still be pending
     * because persistGate hasn't resolved. */
    await new Promise((r) => setImmediate(r));
    expect(resolved).toBe(false);

    /* Resolve as a successful write to confirm the prime completes
     * after the persist returns. */
    resolvePersist({ matchedCount: 1, modifiedCount: 1 });
    await primePromise;

    expect(updateSkillFileCodeEnvIds).toHaveBeenCalledTimes(1);
    const [updates] = updateSkillFileCodeEnvIds.mock.calls[0];
    expect(updates).toEqual([
      {
        skillId: SKILL_ID,
        relativePath: 'references/style.md',
        codeEnvRef: {
          kind: 'skill',
          id: SKILL_ID.toString(),
          storage_session_id: 'session-42',
          file_id: 'file-1',
          version: SKILL_VERSION,
          executionProfile: 'default',
        },
      },
    ]);
  });

  it('reads codeEnvRef in the cached-skills hot path', async () => {
    /* When all skill files are still active in codeapi, primeInvokedSkills
     * skips the batch upload entirely and reconstructs file refs from
     * each skill file's persisted `codeEnvRef`. The kind/version travel
     * through to `CodeSessionContext.files` so the next exec carries
     * them on `_injected_files` for codeapi's sessionKey derivation. */
    const listSkillFiles = jest.fn().mockResolvedValue([
      {
        relativePath: 'references/style.md',
        filename: 'style.md',
        filepath: '/storage/brand-guidelines/references/style.md',
        source: 's3',
        bytes: 256,
        codeEnvRef: {
          kind: 'skill',
          id: SKILL_ID.toString(),
          storage_session_id: 'session-cached',
          file_id: 'file-cached',
          version: SKILL_VERSION,
        },
      },
    ]);
    const batchUploadCodeEnvFiles = jest.fn();
    const getSessionInfo = jest.fn().mockResolvedValue('2026-05-06T00:00:00Z');
    const deps = makeDeps({
      codeEnvAvailable: true,
      listSkillFiles,
      batchUploadCodeEnvFiles,
      getSessionInfo,
      checkIfActive: jest.fn().mockReturnValue(true),
    });

    const result = await primeInvokedSkills(deps);

    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
    expect(getSessionInfo).toHaveBeenCalledWith(
      {
        kind: 'skill',
        id: SKILL_ID.toString(),
        storage_session_id: 'session-cached',
        file_id: 'file-cached',
        version: SKILL_VERSION,
      },
      deps.req,
      undefined,
      undefined,
    );
    const codeSession = result.initialSessions?.get('execute_code');
    expect(codeSession?.files).toEqual([
      {
        id: 'file-cached',
        /* From the cache-hit path: pulls `resource_id` directly off
         * the persisted `codeEnvRef.id` (the skill `_id`). */
        resource_id: SKILL_ID.toString(),
        name: 'skills/brand-guidelines/references/style.md',
        storage_session_id: 'session-cached',
        kind: 'skill',
        version: SKILL_VERSION,
      },
    ]);
  });

  it('falls through to per-skill upload when codeEnvRef version is stale', async () => {
    const listSkillFiles = jest.fn().mockResolvedValue([
      {
        relativePath: 'references/style.md',
        filename: 'style.md',
        filepath: '/storage/brand-guidelines/references/style.md',
        source: 's3',
        bytes: 256,
        codeEnvRef: {
          kind: 'skill',
          id: SKILL_ID.toString(),
          storage_session_id: 'session-stale',
          file_id: 'file-stale',
          version: SKILL_VERSION - 1, // stale: one version behind
        },
      },
    ]);
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'session-fresh',
      files: [{ fileId: 'file-fresh', filename: 'skills/brand-guidelines/references/style.md' }],
    });
    const getStrategyFunctions = jest.fn().mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from('style'))),
    });
    const getSessionInfo = jest.fn();
    const deps = makeDeps({
      codeEnvAvailable: true,
      listSkillFiles,
      batchUploadCodeEnvFiles,
      getStrategyFunctions,
      getSessionInfo,
      checkIfActive: jest.fn().mockReturnValue(true),
    });

    const result = await primeInvokedSkills(deps);

    expect(getSessionInfo).not.toHaveBeenCalled();
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(1);
    const codeSession = result.initialSessions?.get('execute_code');
    expect(codeSession?.files?.[0]?.version).toBe(SKILL_VERSION);
  });
});

describe('primeInvokedSkillsForProfiles', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockExtract.mockReturnValue(new Set(['brand-guidelines']));
  });

  it('uploads and seeds historical skill files separately for every Code API deployment', async () => {
    const listSkillFiles = jest.fn().mockResolvedValue([
      {
        relativePath: 'references/style.md',
        filename: 'style.md',
        filepath: '/storage/brand-guidelines/references/style.md',
        source: 's3',
        bytes: 256,
      },
    ]);
    const getStrategyFunctions = jest.fn().mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from('style'))),
    });
    const batchUploadCodeEnvFiles = jest
      .fn()
      .mockImplementation(({ executionProfile, codeApiBaseUrl }) => ({
        storage_session_id: `${executionProfile}-${new URL(codeApiBaseUrl).hostname}-session`,
        files: [
          {
            fileId: `${executionProfile}-${new URL(codeApiBaseUrl).hostname}-file`,
            filename: 'skills/brand-guidelines/references/style.md',
          },
        ],
      }));
    const updateSkillFileCodeEnvIds = jest.fn().mockResolvedValue({
      matchedCount: 1,
      modifiedCount: 1,
    });
    const {
      codeEnvAvailable: _codeEnvAvailable,
      codeExecutionContext: _codeExecutionContext,
      ...baseDeps
    } = makeDeps({
      listSkillFiles,
      getStrategyFunctions,
      batchUploadCodeEnvFiles,
      updateSkillFileCodeEnvIds,
    });
    const statefulKey = 'execute_code:stateful:v2:user:abc';
    const secondStatefulKey = 'execute_code:stateful:v2:user:def';
    const deps: PrimeInvokedSkillsForProfilesDeps = {
      ...baseDeps,
      executionProfiles: [
        {
          codeExecutionContext: {
            baseUrl: 'https://code.example.com/v1',
            codeSessionKey: 'execute_code',
            executionProfile: 'default',
            statefulSessions: false,
          },
          codeSessionKeys: ['execute_code'],
        },
        {
          codeExecutionContext: {
            baseUrl: 'https://stateful.example.com/v1',
            codeSessionKey: statefulKey,
            executionProfile: 'stateful',
            executionRouteKey: 'stateful:first',
            runtimeSessionHint: 'v2:user:abc',
            statefulSessions: true,
          },
          codeSessionKeys: [statefulKey],
        },
        {
          codeExecutionContext: {
            baseUrl: 'https://second-stateful.example.com/v1',
            codeSessionKey: secondStatefulKey,
            executionProfile: 'stateful',
            executionRouteKey: 'stateful:second',
            runtimeSessionHint: 'v2:user:def',
            statefulSessions: true,
          },
          codeSessionKeys: [secondStatefulKey],
        },
      ],
    };

    const result = await primeInvokedSkillsForProfiles(deps);

    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(3);
    expect(
      batchUploadCodeEnvFiles.mock.calls.map(([args]) => args.executionProfile).sort(),
    ).toEqual(['default', 'stateful', 'stateful']);
    expect(result.initialSessions?.get('execute_code')?.files?.map((file) => file.id)).toEqual([
      'default-code.example.com-file',
    ]);
    expect(result.initialSessions?.get(statefulKey)?.files?.map((file) => file.id)).toEqual([
      'stateful-stateful.example.com-file',
    ]);
    expect(result.initialSessions?.get(secondStatefulKey)?.files?.map((file) => file.id)).toEqual([
      'stateful-second-stateful.example.com-file',
    ]);
    expect(updateSkillFileCodeEnvIds).toHaveBeenCalledTimes(3);
    expect(
      updateSkillFileCodeEnvIds.mock.calls
        .map(([updates]) => updates[0].codeEnvRef.executionProfile)
        .sort(),
    ).toEqual(['default', 'stateful', 'stateful']);
    expect(
      updateSkillFileCodeEnvIds.mock.calls
        .map(([updates]) => updates[0].codeEnvRef.executionRouteKey)
        .filter(Boolean)
        .sort(),
    ).toEqual(['stateful:first', 'stateful:second']);
  });

  it('shares one retry-wait budget across execution profiles', async () => {
    const file = {
      relativePath: 'references/style.md',
      filename: 'style.md',
      filepath: '/storage/style.md',
      source: 's3',
      bytes: 5,
    };
    const attempts = new Map<string, number>();
    const batchUploadCodeEnvFiles = jest.fn(
      async ({ executionProfile }: { executionProfile?: string }) => {
        const profile = executionProfile ?? 'default';
        const attempt = (attempts.get(profile) ?? 0) + 1;
        attempts.set(profile, attempt);
        if (attempt === 1) {
          if (profile === 'stateful') {
            await new Promise((resolve) => setTimeout(resolve, 500));
          }
          const error = Object.assign(new Error('Request failed with status code 429'), {
            isAxiosError: true,
            response: { status: 429, headers: { 'retry-after': '0' } },
          });
          throw error;
        }
        return {
          storage_session_id: `${profile}-session`,
          files: [
            {
              fileId: `${profile}-file`,
              filename: 'skills/brand-guidelines/references/style.md',
            },
          ],
        };
      },
    );
    const { codeEnvAvailable: _codeEnvAvailable, ...baseDeps } = makeDeps({
      listSkillFiles: jest.fn().mockResolvedValue([file]),
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from('style'))),
      }),
      batchUploadCodeEnvFiles,
    });
    baseDeps.req.config = {
      endpoints: { agents: { codeApiMaxRetryWaitMs: 1_000 } },
    } as never;

    const result = await primeInvokedSkillsForProfiles({
      ...baseDeps,
      executionProfiles: [
        {
          codeExecutionContext: {
            baseUrl: 'https://default.example.com/v1',
            codeSessionKey: 'execute_code',
            executionProfile: 'default',
            statefulSessions: false,
          },
          codeSessionKeys: ['execute_code'],
        },
        {
          codeExecutionContext: {
            baseUrl: 'https://stateful.example.com/v1',
            codeSessionKey: 'execute_code:stateful',
            executionProfile: 'stateful',
            executionRouteKey: 'stateful:one',
            statefulSessions: true,
          },
          codeSessionKeys: ['execute_code:stateful'],
        },
      ],
    });

    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(3);
    expect(result.initialSessions?.has('execute_code')).toBe(true);
    expect(result.initialSessions?.has('execute_code:stateful')).toBe(false);
  });

  it('keeps a successful profile Skill body and identity after another profile lookup fails', async () => {
    const {
      codeEnvAvailable: _codeEnvAvailable,
      codeExecutionContext: _codeExecutionContext,
      ...baseDeps
    } = makeDeps({
      getSkillByName: jest
        .fn()
        .mockRejectedValueOnce(new Error('transient lookup failure'))
        .mockResolvedValueOnce({
          _id: SKILL_ID,
          name: 'brand-guidelines',
          body: 'skill body',
          version: SKILL_VERSION,
          fileCount: 0,
        }),
    });
    const deps: PrimeInvokedSkillsForProfilesDeps = {
      ...baseDeps,
      executionProfiles: [
        {
          codeExecutionContext: {
            baseUrl: 'https://code.example.com/v1',
            codeSessionKey: 'execute_code',
            executionProfile: 'default',
            statefulSessions: false,
          },
          codeSessionKeys: ['execute_code'],
        },
        {
          codeExecutionContext: {
            baseUrl: 'https://stateful.example.com/v1',
            codeSessionKey: 'execute_code:stateful:v2:user:abc',
            executionProfile: 'stateful',
            statefulSessions: true,
          },
          codeSessionKeys: ['execute_code:stateful:v2:user:abc'],
        },
      ],
    };

    const result = await primeInvokedSkillsForProfiles(deps);

    expect(result.skills).toEqual(new Map([['brand-guidelines', 'skill body']]));
    expect(result.skillManifest).toEqual([
      {
        id: SKILL_ID.toString(),
        name: 'brand-guidelines',
        version: SKILL_VERSION,
        contentDigest: expect.any(String),
      },
    ]);
  });
});

/* The tool-invoked skill loader (`handle_skill` -> `primeSkillFiles`)
 * is a separate code path from `primeInvokedSkills` (the NL-detected
 * loader). Both feed `_injected_files` on the next /exec; both must
 * carry `resource_id` end-to-end, otherwise codeapi 400s with
 * `resource_id is invalid` (`type: 'undefined'`). Tests below lock
 * that contract on the lower-level helper directly. */
function makeSkillFilesDeps(overrides: Partial<PrimeSkillFilesParams> = {}): PrimeSkillFilesParams {
  return {
    skill: {
      _id: SKILL_ID,
      name: 'brand-guidelines',
      body: 'skill body',
      version: SKILL_VERSION,
    },
    skillFiles: [],
    req: {
      user: { id: 'user-1', tenantId: 'tenant-1' },
      app: { locals: { codeApiUploadRegistry: uploadRegistry } },
    } as unknown as PrimeSkillFilesParams['req'],
    getStrategyFunctions: jest.fn().mockReturnValue({
      getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from(''))),
    }),
    batchUploadCodeEnvFiles: jest.fn().mockResolvedValue({
      storage_session_id: 'session-fresh',
      files: [
        { fileId: 'file-fresh', filename: 'skills/brand-guidelines/references/style.md' },
        { fileId: 'file-skillmd', filename: 'skills/brand-guidelines/SKILL.md' },
      ],
    }),
    ...overrides,
  };
}

describe('primeSkillFiles — resource identity propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('fresh-upload path: emits resource_id=skill._id, kind=skill, version on each file', async () => {
    const deps = makeSkillFilesDeps({
      skillFiles: [
        {
          relativePath: 'references/style.md',
          filename: 'style.md',
          filepath: '/storage/brand-guidelines/references/style.md',
          source: 's3',
          bytes: 256,
        },
      ],
      codeExecutionContext: {
        baseUrl: 'https://stateful-code.example.com',
        executionProfile: 'stateful',
        bridgeWorkerId: 'personal-worker-1',
      },
    });

    const result = await primeSkillFiles(deps);

    expect(deps.batchUploadCodeEnvFiles).toHaveBeenCalledWith(
      expect.objectContaining({
        codeApiBaseUrl: 'https://stateful-code.example.com',
        executionProfile: 'stateful',
        bridgeWorkerId: 'personal-worker-1',
      }),
    );

    expect(result?.files).toEqual([
      {
        id: 'file-fresh',
        resource_id: SKILL_ID.toString(),
        storage_session_id: 'session-fresh',
        name: 'skills/brand-guidelines/references/style.md',
        kind: 'skill',
        version: SKILL_VERSION,
      },
    ]);
  });

  it('cache-hit path: re-derives resource_id/kind/version from persisted codeEnvRef', async () => {
    const cachedRef = {
      kind: 'skill' as const,
      id: SKILL_ID.toString(),
      storage_session_id: 'session-cached',
      file_id: 'file-cached',
      version: SKILL_VERSION,
      executionProfile: 'stateful' as const,
    };
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      skillFiles: [
        {
          relativePath: 'references/style.md',
          filename: 'style.md',
          filepath: '/storage/brand-guidelines/references/style.md',
          source: 's3',
          bytes: 256,
          codeEnvRef: cachedRef,
        },
      ],
      batchUploadCodeEnvFiles,
      getSessionInfo: jest.fn().mockResolvedValue('2026-05-06T00:00:00Z'),
      checkIfActive: jest.fn().mockReturnValue(true),
      codeExecutionContext: {
        baseUrl: 'https://stateful-code.example.com',
        executionProfile: 'stateful',
      },
    });

    const result = await primeSkillFiles(deps);

    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
    expect(deps.getSessionInfo).toHaveBeenCalledWith(
      cachedRef,
      deps.req,
      {
        baseUrl: 'https://stateful-code.example.com',
        executionProfile: 'stateful',
      },
      undefined,
    );
    expect(result?.files).toEqual([
      {
        id: 'file-cached',
        resource_id: SKILL_ID.toString(),
        storage_session_id: 'session-cached',
        name: 'skills/brand-guidelines/references/style.md',
        kind: 'skill',
        version: SKILL_VERSION,
      },
    ]);
  });

  it('reuploads cached refs from an older skill version', async () => {
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'session-fresh',
      files: [
        { fileId: 'file-fresh', filename: 'skills/brand-guidelines/references/style.md' },
        { fileId: 'skill-md', filename: 'skills/brand-guidelines/SKILL.md' },
      ],
    });
    const getSessionInfo = jest.fn();
    const deps = makeSkillFilesDeps({
      skillFiles: [
        {
          relativePath: 'references/style.md',
          filename: 'style.md',
          filepath: '/storage/brand-guidelines/references/style.md',
          source: 's3',
          bytes: 256,
          codeEnvRef: {
            kind: 'skill',
            id: SKILL_ID.toString(),
            storage_session_id: 'session-stale',
            file_id: 'file-stale',
            version: SKILL_VERSION - 1,
          },
        },
      ],
      batchUploadCodeEnvFiles,
      getSessionInfo,
      checkIfActive: jest.fn().mockReturnValue(true),
    });

    const result = await primeSkillFiles(deps);

    expect(getSessionInfo).not.toHaveBeenCalled();
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(1);
    expect(result?.files[0]).toEqual(expect.objectContaining({ version: SKILL_VERSION }));
  });

  it('reuploads a cached ref that belongs to the other execution profile', async () => {
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'stateful-session',
      files: [
        {
          fileId: 'stateful-file',
          filename: 'skills/brand-guidelines/references/style.md',
        },
        { fileId: 'skill-md', filename: 'skills/brand-guidelines/SKILL.md' },
      ],
    });
    const getSessionInfo = jest.fn().mockResolvedValue('2026-05-06T00:00:00Z');
    const deps = makeSkillFilesDeps({
      skillFiles: [
        {
          relativePath: 'references/style.md',
          filename: 'style.md',
          filepath: '/storage/brand-guidelines/references/style.md',
          source: 's3',
          bytes: 256,
          codeEnvRef: {
            kind: 'skill',
            id: SKILL_ID.toString(),
            storage_session_id: 'default-session',
            file_id: 'default-file',
            version: SKILL_VERSION,
            executionProfile: 'default',
          },
        },
      ],
      batchUploadCodeEnvFiles,
      getSessionInfo,
      checkIfActive: jest.fn().mockReturnValue(true),
      codeExecutionContext: {
        baseUrl: 'https://stateful-code.example.com',
        executionProfile: 'stateful',
      },
    });

    const result = await primeSkillFiles(deps);

    expect(getSessionInfo).not.toHaveBeenCalled();
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledWith(
      expect.objectContaining({ executionProfile: 'stateful' }),
    );
    expect(result?.files[0].id).toBe('stateful-file');
  });

  it('does not download active cached bundles for metadata-only filters', async () => {
    const getDownloadStream = jest.fn();
    const getStrategyFunctions = jest.fn().mockReturnValue({ getDownloadStream });
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1', tenantId: 'tenant-1' },
        app: { locals: { codeApiUploadRegistry: uploadRegistry } },
        config: {
          filters: {
            skills: {
              pii: {
                fields: ['file_name'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
        },
      } as unknown as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/style.md',
          filename: 'style.md',
          filepath: '/storage/brand-guidelines/references/style.md',
          source: 's3',
          bytes: 256,
          codeEnvRef: {
            kind: 'skill',
            id: SKILL_ID.toString(),
            storage_session_id: 'session-cached',
            file_id: 'file-cached',
            version: SKILL_VERSION,
          },
        },
      ],
      getStrategyFunctions,
      batchUploadCodeEnvFiles,
      getSessionInfo: jest.fn().mockResolvedValue('2026-05-06T00:00:00Z'),
      checkIfActive: jest.fn().mockReturnValue(true),
    });

    await expect(primeSkillFiles(deps)).resolves.toMatchObject({
      storage_session_id: 'session-cached',
      files: [{ id: 'file-cached' }],
    });
    expect(getStrategyFunctions).not.toHaveBeenCalled();
    expect(getDownloadStream).not.toHaveBeenCalled();
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('treats omitted fields as requiring bundled content inspection', async () => {
    const getDownloadStream = jest
      .fn()
      .mockResolvedValue(Readable.from(Buffer.from('historical sk-private-value')));
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1', tenantId: 'tenant-1' },
        app: { locals: { codeApiUploadRegistry: uploadRegistry } },
        config: {
          filters: {
            files: {
              pii: {
                starterPatterns: ['sk_prefix'],
              },
            },
          },
        },
      } as unknown as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/style.md',
          filename: 'style.md',
          filepath: '/storage/brand-guidelines/references/style.md',
          source: 's3',
          bytes: 24,
          codeEnvRef: {
            kind: 'skill',
            id: SKILL_ID.toString(),
            storage_session_id: 'session-cached',
            file_id: 'file-cached',
            version: SKILL_VERSION,
          },
        },
      ],
      getStrategyFunctions: jest.fn().mockReturnValue({ getDownloadStream }),
      batchUploadCodeEnvFiles,
      getSessionInfo: jest.fn().mockResolvedValue('2026-05-06T00:00:00Z'),
      checkIfActive: jest.fn().mockReturnValue(true),
    });

    await expect(primeSkillFiles(deps)).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'file', field: 'content' },
    });
    expect(getDownloadStream).toHaveBeenCalledTimes(1);
    expect(deps.getSessionInfo).not.toHaveBeenCalled();
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('still blocks bundled file names before metadata-only cache reuse', async () => {
    const getStrategyFunctions = jest.fn();
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            files: {
              pii: {
                fields: ['name'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
        },
      } as unknown as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/sk-private-name.md',
          filename: 'sk-private-name.md',
          filepath: '/storage/brand-guidelines/references/sk-private-name.md',
          source: 's3',
          bytes: 256,
          codeEnvRef: {
            kind: 'skill',
            id: SKILL_ID.toString(),
            storage_session_id: 'session-cached',
            file_id: 'file-cached',
            version: SKILL_VERSION,
          },
        },
      ],
      getStrategyFunctions,
      batchUploadCodeEnvFiles,
      getSessionInfo: jest.fn().mockResolvedValue('2026-05-06T00:00:00Z'),
      checkIfActive: jest.fn().mockReturnValue(true),
    });

    await expect(primeSkillFiles(deps)).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'file', field: 'name' },
    });
    expect(getStrategyFunctions).not.toHaveBeenCalled();
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('re-inspects bundled text created before a skills policy is enabled', async () => {
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            skills: {
              pii: {
                fields: ['file_text'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
        },
      } as unknown as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/style.md',
          filename: 'style.md',
          filepath: '/storage/brand-guidelines/references/style.md',
          source: 's3',
          bytes: 24,
          codeEnvRef: {
            kind: 'skill',
            id: SKILL_ID.toString(),
            storage_session_id: 'session-cached',
            file_id: 'file-cached',
            version: SKILL_VERSION,
          },
        },
      ],
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest
          .fn()
          .mockResolvedValue(Readable.from(Buffer.from('historical sk-private-value'))),
      }),
      batchUploadCodeEnvFiles,
      getSessionInfo: jest.fn().mockResolvedValue('2026-05-06T00:00:00Z'),
      checkIfActive: jest.fn().mockReturnValue(true),
    });

    await expect(primeSkillFiles(deps)).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'skill', field: 'file_text' },
    });
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('classifies decoded bundled text as extracted file text', async () => {
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            files: {
              pii: {
                fields: ['extracted_text'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
        },
      } as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/style.md',
          filename: 'style.md',
          filepath: '/storage/brand-guidelines/references/style.md',
          source: 's3',
          bytes: 24,
        },
      ],
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest
          .fn()
          .mockResolvedValue(Readable.from(Buffer.from('historical sk-private-value'))),
      }),
      batchUploadCodeEnvFiles,
    });

    await expect(primeSkillFiles(deps)).rejects.toMatchObject({
      code: 'content_filter_block',
      body: { source: 'file', field: 'extracted_text' },
    });
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('blocks opaque bundled files before upload when fail-close is enabled', async () => {
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            files: {
              pii: {
                fields: ['content'],
                starterPatterns: ['sk_prefix'],
                uninspectable: 'block',
              },
            },
          },
        },
      } as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/archive.bin',
          filename: 'archive.bin',
          filepath: '/storage/brand-guidelines/references/archive.bin',
          source: 's3',
          bytes: 3,
        },
      ],
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from([0, 255, 1]))),
      }),
      batchUploadCodeEnvFiles,
    });

    await expect(primeSkillFiles(deps)).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'content' },
    });
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('fails closed for binary bundles when extracted text must be inspectable', async () => {
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            files: {
              pii: {
                fields: ['extracted_text'],
                starterPatterns: ['sk_prefix'],
                uninspectable: 'block',
              },
            },
          },
        },
      } as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/archive.bin',
          filename: 'archive.bin',
          filepath: '/storage/brand-guidelines/references/archive.bin',
          source: 's3',
          bytes: 3,
        },
      ],
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from([0, 255, 1]))),
      }),
      batchUploadCodeEnvFiles,
    });

    await expect(primeSkillFiles(deps)).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'extracted_text' },
    });
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('fails closed for oversized bundles when extracted text must be inspectable', async () => {
    const getStrategyFunctions = jest.fn();
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            files: {
              pii: {
                fields: ['extracted_text'],
                starterPatterns: ['sk_prefix'],
                uninspectable: 'block',
              },
            },
          },
        },
      } as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/archive.txt',
          filename: 'archive.txt',
          filepath: '/storage/brand-guidelines/references/archive.txt',
          source: 's3',
          bytes: 10 * 1024 * 1024 + 1,
        },
      ],
      getStrategyFunctions,
      batchUploadCodeEnvFiles,
    });

    await expect(primeSkillFiles(deps)).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'extracted_text' },
    });
    expect(getStrategyFunctions).not.toHaveBeenCalled();
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('fails closed for oversized bundles selected by the skill file_text policy', async () => {
    const getStrategyFunctions = jest.fn();
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            skills: {
              pii: {
                fields: ['file_text'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
        },
      } as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/oversized.txt',
          filename: 'oversized.txt',
          filepath: '/storage/brand-guidelines/references/oversized.txt',
          source: 's3',
          bytes: 10 * 1024 * 1024 + 1,
        },
      ],
      getStrategyFunctions,
      batchUploadCodeEnvFiles,
    });

    await expect(primeSkillFiles(deps)).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'content' },
    });
    expect(getStrategyFunctions).not.toHaveBeenCalled();
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('fails closed when a selected skill file_text bundle cannot be downloaded', async () => {
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            skills: {
              pii: {
                fields: ['file_text'],
                starterPatterns: ['sk_prefix'],
              },
            },
            files: {
              pii: {
                fields: ['content'],
                starterPatterns: ['sk_prefix'],
                uninspectable: 'allow',
              },
            },
          },
        },
      } as unknown as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/unavailable.txt',
          filename: 'unavailable.txt',
          filepath: '/storage/brand-guidelines/references/unavailable.txt',
          source: 's3',
          bytes: 256,
        },
      ],
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest.fn().mockRejectedValue(new Error('storage unavailable')),
      }),
      batchUploadCodeEnvFiles,
    });

    await expect(primeSkillFiles(deps)).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'content' },
    });
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('fails closed for binary bundles selected by the skill file_text policy', async () => {
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            skills: {
              pii: {
                fields: ['file_text'],
                starterPatterns: ['sk_prefix'],
              },
            },
            files: {
              pii: {
                fields: ['content'],
                starterPatterns: ['sk_prefix'],
                uninspectable: 'allow',
              },
            },
          },
        },
      } as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/archive.bin',
          filename: 'archive.bin',
          filepath: '/storage/brand-guidelines/references/archive.bin',
          source: 's3',
          bytes: 3,
        },
      ],
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from([0, 255, 1]))),
      }),
      batchUploadCodeEnvFiles,
    });

    await expect(primeSkillFiles(deps)).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'content' },
    });
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('does not reuse an active cached ref when selected skill file_text is unavailable', async () => {
    const getSessionInfo = jest.fn().mockResolvedValue('2026-05-06T00:00:00Z');
    const batchUploadCodeEnvFiles = jest.fn();
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1' },
        config: {
          filters: {
            skills: {
              pii: {
                fields: ['file_text'],
                starterPatterns: ['sk_prefix'],
              },
            },
          },
        },
      } as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/unavailable.txt',
          filename: 'unavailable.txt',
          filepath: '/storage/brand-guidelines/references/unavailable.txt',
          source: 's3',
          bytes: 256,
          codeEnvRef: {
            kind: 'skill',
            id: SKILL_ID.toString(),
            storage_session_id: 'session-cached',
            file_id: 'file-cached',
            version: SKILL_VERSION,
          },
        },
      ],
      getStrategyFunctions: jest.fn().mockReturnValue({}),
      batchUploadCodeEnvFiles,
      getSessionInfo,
      checkIfActive: jest.fn().mockReturnValue(true),
    });

    await expect(primeSkillFiles(deps)).rejects.toMatchObject({
      code: 'content_filter_uninspectable',
      body: { source: 'file', field: 'content' },
    });
    expect(getSessionInfo).not.toHaveBeenCalled();
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('retains explicit allow behavior for opaque bundled files', async () => {
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue({
      storage_session_id: 'session-allowed',
      files: [
        {
          fileId: 'file-allowed',
          filename: 'skills/brand-guidelines/references/archive.bin',
        },
        {
          fileId: 'file-skillmd',
          filename: 'skills/brand-guidelines/SKILL.md',
        },
      ],
    });
    const deps = makeSkillFilesDeps({
      req: {
        user: { id: 'user-1', tenantId: 'tenant-1' },
        app: { locals: { codeApiUploadRegistry: uploadRegistry } },
        config: {
          filters: {
            files: {
              pii: {
                fields: ['content'],
                starterPatterns: ['sk_prefix'],
                uninspectable: 'allow',
              },
            },
          },
        },
      } as unknown as PrimeSkillFilesParams['req'],
      skillFiles: [
        {
          relativePath: 'references/archive.bin',
          filename: 'archive.bin',
          filepath: '/storage/brand-guidelines/references/archive.bin',
          source: 's3',
          bytes: 3,
        },
      ],
      getStrategyFunctions: jest.fn().mockReturnValue({
        getDownloadStream: jest.fn().mockResolvedValue(Readable.from(Buffer.from([0, 255, 1]))),
      }),
      batchUploadCodeEnvFiles,
    });

    await expect(primeSkillFiles(deps)).resolves.toMatchObject({
      storage_session_id: 'session-allowed',
      files: [{ id: 'file-allowed' }],
    });
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(1);
  });
});

/* Codeapi's upload limiter defaults to 30 requests per user per 5 minutes,
 * and a workflow with many cold skills used to fan out one unbounded batch
 * upload per skill. The suite below locks the three mitigations: process-
 * wide upload slots, single-flight per (skill, version), and a single
 * Retry-After-honoring retry on 429. */
describe('primeSkillFiles — upload rate-limit resilience', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  const flush = () => new Promise((resolve) => setImmediate(resolve));

  function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }

  function styleFileRecord() {
    return {
      relativePath: 'references/style.md',
      filename: 'style.md',
      filepath: '/storage/brand-guidelines/references/style.md',
      source: 's3',
      bytes: 256,
    };
  }

  function uploadResult(skillName = 'brand-guidelines') {
    return {
      storage_session_id: `session-${skillName}`,
      files: [
        { fileId: `file-${skillName}`, filename: `skills/${skillName}/references/style.md` },
        { fileId: `skillmd-${skillName}`, filename: `skills/${skillName}/SKILL.md` },
      ],
    };
  }

  function rateLimit429(retryAfter: string) {
    const error = new Error('Request failed with status code 429') as Error & {
      isAxiosError: boolean;
      response: { status: number; headers: Record<string, string> };
    };
    error.isAxiosError = true;
    error.response = { status: 429, headers: { 'retry-after': retryAfter } };
    return error;
  }

  it('single-flights concurrent primes of the same skill+version, clearing the flight on settle', async () => {
    const gate = deferred<ReturnType<typeof uploadResult>>();
    const batchUploadCodeEnvFiles = jest.fn().mockReturnValue(gate.promise);

    const first = primeSkillFiles(
      makeSkillFilesDeps({ skillFiles: [styleFileRecord()], batchUploadCodeEnvFiles }),
    );
    const second = primeSkillFiles(
      makeSkillFilesDeps({ skillFiles: [styleFileRecord()], batchUploadCodeEnvFiles }),
    );
    await flush();
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(1);

    gate.resolve(uploadResult());
    const [firstResult, secondResult] = await Promise.all([first, second]);
    /* Joiners share the leader's result object, not a re-upload. */
    expect(firstResult).toBe(secondResult);
    expect(firstResult?.files).toHaveLength(1);

    await primeSkillFiles(
      makeSkillFilesDeps({ skillFiles: [styleFileRecord()], batchUploadCodeEnvFiles }),
    );
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(2);
  });

  it('primes different versions of the same skill independently', async () => {
    const batchUploadCodeEnvFiles = jest.fn().mockResolvedValue(uploadResult());
    await Promise.all([
      primeSkillFiles(
        makeSkillFilesDeps({ skillFiles: [styleFileRecord()], batchUploadCodeEnvFiles }),
      ),
      primeSkillFiles(
        makeSkillFilesDeps({
          skill: {
            _id: SKILL_ID,
            name: 'brand-guidelines',
            body: 'skill body',
            version: SKILL_VERSION + 1,
          },
          skillFiles: [styleFileRecord()],
          batchUploadCodeEnvFiles,
        }),
      ),
    ]);
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(2);
  });

  it('retries once on 429 within the Retry-After cap, re-acquiring streams per attempt', async () => {
    const getDownloadStream = jest.fn(async () => Readable.from(Buffer.from('')));
    const batchUploadCodeEnvFiles = jest
      .fn()
      .mockRejectedValueOnce(rateLimit429('0'))
      .mockResolvedValueOnce(uploadResult());

    const result = await primeSkillFiles(
      makeSkillFilesDeps({
        skillFiles: [styleFileRecord()],
        batchUploadCodeEnvFiles,
        getStrategyFunctions: jest.fn().mockReturnValue({ getDownloadStream }),
      }),
    );

    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(2);
    /* A consumed stream cannot be replayed — each attempt opens fresh ones. */
    expect(getDownloadStream).toHaveBeenCalledTimes(2);
    expect(result?.files).toHaveLength(1);
  });

  it('does not retry when Retry-After exceeds the cap', async () => {
    const batchUploadCodeEnvFiles = jest.fn().mockRejectedValue(rateLimit429('300'));
    const result = await primeSkillFiles(
      makeSkillFilesDeps({ skillFiles: [styleFileRecord()], batchUploadCodeEnvFiles }),
    );
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('does not retry non-429 failures', async () => {
    const batchUploadCodeEnvFiles = jest.fn().mockRejectedValue(new Error('boom'));
    const result = await primeSkillFiles(
      makeSkillFilesDeps({ skillFiles: [styleFileRecord()], batchUploadCodeEnvFiles }),
    );
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('does not upload a partial skill bundle when stream acquisition is canceled', async () => {
    const controller = new AbortController();
    const batchUploadCodeEnvFiles = jest.fn();
    const acquiredStream = Readable.from(Buffer.from('style'));
    const destroy = jest.spyOn(acquiredStream, 'destroy');
    const getDownloadStream = jest.fn(async () => {
      controller.abort();
      return acquiredStream;
    });

    await expect(
      primeSkillFiles(
        makeSkillFilesDeps({
          signal: controller.signal,
          skillFiles: [styleFileRecord()],
          batchUploadCodeEnvFiles,
          getStrategyFunctions: jest.fn().mockReturnValue({ getDownloadStream }),
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(getDownloadStream).toHaveBeenCalledWith(expect.anything(), expect.any(String), {
      signal: controller.signal,
    });
    expect(destroy).toHaveBeenCalled();
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('does not return a cache hit when cancellation arrives during its liveness check', async () => {
    const controller = new AbortController();
    const batchUploadCodeEnvFiles = jest.fn();
    const getSessionInfo = jest.fn(async () => {
      controller.abort();
      return '2026-05-06T00:00:00Z';
    });
    const cachedFile = {
      ...styleFileRecord(),
      codeEnvRef: {
        kind: 'skill' as const,
        id: SKILL_ID.toString(),
        storage_session_id: 'session-cached',
        file_id: 'file-cached',
        version: SKILL_VERSION,
      },
    };

    await expect(
      primeSkillFiles(
        makeSkillFilesDeps({
          signal: controller.signal,
          skillFiles: [cachedFile],
          batchUploadCodeEnvFiles,
          getSessionInfo,
          checkIfActive: jest.fn().mockReturnValue(true),
        }),
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(getSessionInfo).toHaveBeenCalledWith(
      expect.any(Object),
      expect.any(Object),
      undefined,
      controller.signal,
    );
    expect(batchUploadCodeEnvFiles).not.toHaveBeenCalled();
  });

  it('bounds concurrent batch uploads to 3 application-scoped slots', async () => {
    const gates = Array.from({ length: 5 }, () => deferred<ReturnType<typeof uploadResult>>());
    let uploadIndex = 0;
    const batchUploadCodeEnvFiles = jest
      .fn()
      .mockImplementation(() => gates[uploadIndex++].promise);
    const skillNames = Array.from({ length: 5 }, (_, i) => `skill-${i}`);

    const primes = skillNames.map((name) =>
      primeSkillFiles(
        makeSkillFilesDeps({
          skill: { _id: new Types.ObjectId(), name, body: 'skill body', version: 1 },
          skillFiles: [styleFileRecord()],
          batchUploadCodeEnvFiles,
        }),
      ),
    );

    await flush();
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(3);

    gates[0].resolve(uploadResult(skillNames[0]));
    await flush();
    expect(batchUploadCodeEnvFiles).toHaveBeenCalledTimes(4);

    for (let i = 1; i < gates.length; i++) {
      gates[i].resolve(uploadResult(skillNames[i]));
    }
    const results = await Promise.all(primes);
    expect(results.every((r) => r !== null)).toBe(true);
  });
});
