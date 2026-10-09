const mockGetAppConfig = jest.fn();
const mockGetStrategyFunctions = jest.fn();
const mockGetFileStrategy = jest.fn();
const mockFindRoleByIdentifier = jest.fn();
const mockGrantPermission = jest.fn();
let mockRunnerDeps;
let mockRunnerStatus;
const mockCreatedRunners = [];

jest.mock('~/server/services/Config', () => ({
  getAppConfig: mockGetAppConfig,
}));

jest.mock('@librechat/api', () => {
  const actualApi = jest.requireActual('@librechat/api');
  return {
    createSkillSyncTriggerOrchestrator: actualApi.createSkillSyncTriggerOrchestrator,
    createGitHubSkillSyncRunner: jest.fn((deps) => {
      mockRunnerDeps = deps;
      const runner = {
        getStatus: jest.fn(async () => {
          if (mockRunnerStatus) {
            return mockRunnerStatus;
          }
          const config = await deps.getConfig();
          const github = config?.github ?? {};
          return {
            enabled: github.enabled ?? false,
            intervalMinutes: github.intervalMinutes ?? 60,
            runOnStartup: github.runOnStartup ?? false,
            sources: (github.sources ?? []).map((source) => ({
              provider: 'github',
              sourceId: source.id,
              status: 'idle',
              credentialPresent:
                deps.allowServerCredentials !== false &&
                Boolean(source.credentialKey || source.token),
              owner: source.owner,
              repo: source.repo,
              ref: source.ref,
              paths: source.paths,
              syncedSkillCount: 0,
              syncedFileCount: 0,
              deletedSkillCount: 0,
              deletedFileCount: 0,
            })),
            credentials: [],
          };
        }),
        runOnce: jest.fn(async () => deps.getConfig()),
      };
      mockCreatedRunners.push({ deps, runner });
      return runner;
    }),
    getStorageMetadata: jest.fn(() => ({})),
    startGitHubSkillSyncScheduler: jest.fn(() => ({ stop: jest.fn() })),
  };
});

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
    warn: jest.fn(),
  },
  runAsSystem: jest.fn((fn) => fn()),
}));

jest.mock('~/models', () => ({
  findRoleByIdentifier: mockFindRoleByIdentifier,
  grantPermission: mockGrantPermission,
  getSkillSyncCredentialToken: jest.fn(),
  getSkillSyncCredentialSummary: jest.fn(),
  listSkillSyncCredentials: jest.fn(async () => []),
  listSkillSyncStatuses: jest.fn(async () => []),
  upsertSkillSyncStatus: jest.fn(),
  tryAcquireSkillSyncLock: jest.fn(),
  refreshSkillSyncLock: jest.fn(),
  releaseSkillSyncLock: jest.fn(),
  createSkill: jest.fn(),
  updateSkill: jest.fn(),
  getSkillById: jest.fn(),
  findSkillBySourceIdentity: jest.fn(),
  listSkillsBySource: jest.fn(),
  listSkillFiles: jest.fn(),
  getSkillFileByPath: jest.fn(),
  upsertSkillFile: jest.fn(),
  deleteSkillFile: jest.fn(),
  deleteSkill: jest.fn(),
}));
jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: mockGetStrategyFunctions,
}));
jest.mock('~/server/utils/getFileStrategy', () => ({ getFileStrategy: mockGetFileStrategy }));

describe('GitHub skill sync service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetAppConfig.mockReset();
    mockGetStrategyFunctions.mockReset();
    mockGetFileStrategy.mockReset();
    mockFindRoleByIdentifier.mockReset();
    mockGrantPermission.mockReset();
    mockRunnerDeps = undefined;
    mockRunnerStatus = undefined;
    mockCreatedRunners.length = 0;
  });

  it('resolves sync config from fresh base app config for runner operations', async () => {
    const startupSkillSync = {
      github: {
        enabled: false,
        intervalMinutes: 60,
        runOnStartup: false,
        sources: [],
      },
    };
    const freshSkillSync = {
      github: {
        enabled: true,
        intervalMinutes: 5,
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
    };
    mockGetAppConfig.mockResolvedValue({ skillSync: freshSkillSync });

    const service = require('./sync');
    const { runner } = service.initializeGitHubSkillSync({ skillSync: startupSkillSync });
    const result = await runner.runOnce();

    expect(result).toBe(freshSkillSync);
    expect(mockRunnerDeps.getConfig).toBeDefined();
    expect(mockGetAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });

  it('does not return raw unvalidated config.skillSync as sync config', async () => {
    const rawSkillSync = {
      github: {
        enabled: true,
        sources: 'not-an-array',
      },
    };
    mockGetAppConfig.mockResolvedValue({ config: { skillSync: rawSkillSync } });

    const service = require('./sync');
    const { runner } = service.initializeGitHubSkillSync({ config: { skillSync: rawSkillSync } });
    const result = await runner.runOnce();

    expect(result).toBeUndefined();
    expect(mockGetAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });

  it('does not let user skill-list sync use server credentials from resolved config', async () => {
    const skillSync = {
      github: {
        enabled: true,
        intervalMinutes: 60,
        runOnStartup: true,
        sources: [
          {
            id: 'tenant-skills',
            owner: 'LibreChat',
            repo: 'skills',
            ref: 'main',
            paths: ['skills'],
            token: '${GITHUB_SKILLS_TOKEN}',
            tenantId: 'other-tenant',
          },
        ],
      },
    };

    const service = require('./sync');
    const started = await service.maybeRunGitHubSkillSyncForRequest({
      config: { skillSync, config: {} },
      user: { id: 'user-1', tenantId: 'tenant-a' },
    });

    const requestRunner = mockCreatedRunners[0].runner;
    const requestConfig = await mockCreatedRunners[0].deps.getConfig();
    expect(started).toBe(false);
    expect(mockCreatedRunners[0].deps.allowServerCredentials).toBe(false);
    expect(requestRunner.runOnce).not.toHaveBeenCalled();
    expect(requestConfig.github.runOnStartup).toBe(false);
    expect(requestConfig.github.sources[0]).toEqual(
      expect.objectContaining({
        id: 'tenant-skills',
        tenantId: 'tenant-a',
      }),
    );
  });

  it('does not auto-start request-scoped sync when server credentials are unavailable', async () => {
    const skillSync = {
      github: {
        enabled: true,
        intervalMinutes: 60,
        runOnStartup: true,
        sources: [
          {
            id: 'tenant-skills',
            owner: 'LibreChat',
            repo: 'skills',
            ref: 'main',
            paths: ['skills'],
            token: '${GITHUB_SKILLS_TOKEN}',
          },
        ],
      },
    };
    mockRunnerStatus = {
      enabled: true,
      intervalMinutes: 60,
      runOnStartup: false,
      sources: [
        {
          provider: 'github',
          sourceId: 'tenant-skills',
          status: 'idle',
          credentialPresent: false,
          owner: 'LibreChat',
          repo: 'skills',
          ref: 'main',
          paths: ['skills'],
          syncedSkillCount: 0,
          syncedFileCount: 0,
          deletedSkillCount: 0,
          deletedFileCount: 0,
        },
      ],
      credentials: [],
    };

    const service = require('./sync');
    const started = await service.maybeRunGitHubSkillSyncForRequest({
      config: { skillSync, config: {} },
      user: { id: 'user-1', tenantId: 'tenant-a' },
    });

    expect(started).toBe(false);
    expect(mockCreatedRunners[0].deps.allowServerCredentials).toBe(false);
    expect(mockCreatedRunners[0].runner.runOnce).not.toHaveBeenCalled();
  });

  it('does not start a request-scoped sync for base YAML skillSync config', async () => {
    const skillSync = {
      github: {
        enabled: true,
        intervalMinutes: 60,
        runOnStartup: true,
        sources: [
          {
            id: 'base-skills',
            owner: 'LibreChat',
            repo: 'skills',
            ref: 'main',
            paths: ['skills'],
            token: '${GITHUB_SKILLS_TOKEN}',
          },
        ],
      },
    };
    mockGetAppConfig.mockResolvedValue({ skillSync });

    const service = require('./sync');
    const started = await service.maybeRunGitHubSkillSyncForRequest({
      config: { skillSync },
      user: { id: 'user-1', tenantId: 'tenant-a' },
    });

    expect(started).toBe(false);
    expect(mockCreatedRunners).toHaveLength(0);
    expect(mockGetAppConfig).toHaveBeenCalledWith({ baseOnly: true });
  });

  it('creates an admin request runner from resolved skillSync config overrides', async () => {
    const skillSync = {
      github: {
        enabled: true,
        intervalMinutes: 60,
        runOnStartup: true,
        sources: [
          {
            id: 'tenant-skills',
            owner: 'LibreChat',
            repo: 'skills',
            ref: 'main',
            paths: ['skills'],
            token: '${GITHUB_SKILLS_TOKEN}',
            tenantId: 'other-tenant',
          },
        ],
      },
    };

    const service = require('./sync');
    const runner = service.getGitHubSkillSyncRunnerForRequest({
      config: { skillSync, config: {} },
      user: { id: 'user-1', tenantId: 'tenant-a' },
      skillSyncAllowServerCredentials: true,
    });
    const config = await mockCreatedRunners[0].deps.getConfig();

    expect(runner.runOnce).toBe(mockCreatedRunners[0].runner.runOnce);
    expect(runner.getStatus).toBe(mockCreatedRunners[0].runner.getStatus);
    expect(mockCreatedRunners[0].deps.allowServerCredentials).toBe(true);
    expect(config.github.runOnStartup).toBe(true);
    expect(config.github.sources[0]).toEqual(
      expect.objectContaining({ id: 'tenant-skills', tenantId: 'tenant-a' }),
    );
  });

  it('preserves base admin runner tenant scope when request config has no nested base copy', async () => {
    const skillSync = {
      github: {
        enabled: true,
        intervalMinutes: 60,
        runOnStartup: true,
        sources: [
          {
            id: 'base-skills',
            owner: 'LibreChat',
            repo: 'skills',
            ref: 'main',
            paths: ['skills'],
            token: '${GITHUB_SKILLS_TOKEN}',
            tenantId: 'base-tenant',
          },
        ],
      },
    };

    const service = require('./sync');
    service.initializeGitHubSkillSync({ skillSync });
    service.getGitHubSkillSyncRunnerForRequest({
      config: { skillSync },
      user: { id: 'user-1', tenantId: 'tenant-a' },
      skillSyncAllowServerCredentials: true,
    });
    const config = await mockCreatedRunners[1].deps.getConfig();

    expect(config.github.sources[0]).toEqual(
      expect.objectContaining({ id: 'base-skills', tenantId: 'base-tenant' }),
    );
  });

  it('does not allow request-built admin override runners to use server credentials by default', async () => {
    const skillSync = {
      github: {
        enabled: true,
        intervalMinutes: 60,
        runOnStartup: true,
        sources: [
          {
            id: 'tenant-skills',
            owner: 'LibreChat',
            repo: 'skills',
            ref: 'main',
            paths: ['skills'],
            token: '${GITHUB_SKILLS_TOKEN}',
          },
        ],
      },
    };

    const service = require('./sync');
    service.getGitHubSkillSyncRunnerForRequest({
      config: { skillSync, config: {} },
      user: { id: 'user-1', tenantId: 'tenant-a' },
    });

    expect(mockCreatedRunners[0].deps.allowServerCredentials).toBe(false);
  });

  it('does not start a request-scoped sync when the configured source is already running', async () => {
    const skillSync = {
      github: {
        enabled: true,
        intervalMinutes: 60,
        runOnStartup: false,
        sources: [
          {
            id: 'tenant-skills',
            owner: 'LibreChat',
            repo: 'skills',
            ref: 'main',
            paths: ['skills'],
            token: '${GITHUB_SKILLS_TOKEN}',
          },
        ],
      },
    };
    mockRunnerStatus = {
      enabled: true,
      intervalMinutes: 60,
      runOnStartup: false,
      sources: [
        {
          provider: 'github',
          sourceId: 'tenant-skills',
          status: 'running',
          credentialPresent: true,
          owner: 'LibreChat',
          repo: 'skills',
          ref: 'main',
          paths: ['skills'],
          startedAt: new Date(),
          syncedSkillCount: 0,
          syncedFileCount: 0,
          deletedSkillCount: 0,
          deletedFileCount: 0,
        },
      ],
      credentials: [],
    };

    const service = require('./sync');
    const started = await service.maybeRunGitHubSkillSyncForRequest({
      config: { skillSync, config: {} },
      user: { id: 'user-1', tenantId: 'tenant-a' },
    });

    expect(started).toBe(false);
    expect(mockCreatedRunners[0].runner.runOnce).not.toHaveBeenCalled();
  });

  it('retries a request-scoped sync when a running source status is stale', async () => {
    const skillSync = {
      github: {
        enabled: true,
        intervalMinutes: 60,
        runOnStartup: false,
        sources: [
          {
            id: 'tenant-skills',
            owner: 'LibreChat',
            repo: 'skills',
            ref: 'main',
            paths: ['skills'],
            token: '${GITHUB_SKILLS_TOKEN}',
          },
        ],
      },
    };
    mockRunnerStatus = {
      enabled: true,
      intervalMinutes: 60,
      runOnStartup: false,
      sources: [
        {
          provider: 'github',
          sourceId: 'tenant-skills',
          status: 'running',
          credentialPresent: true,
          owner: 'LibreChat',
          repo: 'skills',
          ref: 'main',
          paths: ['skills'],
          startedAt: new Date(Date.now() - 40 * 60 * 1000),
          syncedSkillCount: 0,
          syncedFileCount: 0,
          deletedSkillCount: 0,
          deletedFileCount: 0,
        },
      ],
      credentials: [],
    };

    const service = require('./sync');
    const started = await service.maybeRunGitHubSkillSyncForRequest({
      config: { skillSync, config: {} },
      user: { id: 'user-1', tenantId: 'tenant-a' },
    });

    expect(started).toBe(true);
    expect(mockCreatedRunners[0].runner.runOnce).toHaveBeenCalledTimes(1);
  });

  it('uses the file owner when deleting synced files from storage', async () => {
    const deleteFile = jest.fn(async () => undefined);
    const ownerId = '507f1f77bcf86cd799439011';
    mockGetAppConfig.mockResolvedValue({ skillSync: undefined, paths: {} });
    mockGetStrategyFunctions.mockReturnValue({ deleteFile });

    const service = require('./sync');
    service.initializeGitHubSkillSync({ skillSync: undefined });
    await mockRunnerDeps.deleteFile({
      filepath: `/uploads/${ownerId}/file.txt`,
      source: 'local',
      user: ownerId,
      tenantId: 'tenant-a',
    });

    expect(deleteFile).toHaveBeenCalledWith(
      expect.objectContaining({
        user: expect.objectContaining({
          id: ownerId,
          _id: ownerId,
          tenantId: 'tenant-a',
        }),
      }),
      expect.objectContaining({
        user: ownerId,
        tenantId: 'tenant-a',
      }),
    );
  });

  it('does not force manual sync runs into the system tenant context', async () => {
    const { runAsSystem } = require('@librechat/data-schemas');
    mockGetAppConfig.mockResolvedValue({ skillSync: undefined, paths: {} });

    const service = require('./sync');
    const { runner } = service.initializeGitHubSkillSync({ skillSync: undefined });
    await runner.runOnce();

    expect(runAsSystem).not.toHaveBeenCalled();
  });

  it('resolves the access role outside tenant isolation but writes the ACL in context', async () => {
    const { runAsSystem } = require('@librechat/data-schemas');
    mockGetAppConfig.mockResolvedValue({ skillSync: undefined, paths: {} });
    mockFindRoleByIdentifier.mockResolvedValue({
      _id: 'role-object-id',
      resourceType: 'skill',
      permBits: 1,
    });
    mockGrantPermission.mockResolvedValue({ _id: 'acl-entry-id' });

    const service = require('./sync');
    service.initializeGitHubSkillSync({ skillSync: undefined });
    await mockRunnerDeps.grantPermission({
      principalType: 'public',
      principalId: null,
      resourceType: 'skill',
      resourceId: 'skill-id',
      accessRoleId: 'skill_viewer',
      grantedBy: 'system',
    });

    expect(runAsSystem).toHaveBeenCalledTimes(1);
    expect(mockFindRoleByIdentifier).toHaveBeenCalledWith('skill_viewer');
    expect(mockGrantPermission).toHaveBeenCalledWith(
      'public',
      null,
      'skill',
      'skill-id',
      1,
      'system',
      undefined,
      'role-object-id',
    );
  });

  it('fails the grant when the access role does not exist', async () => {
    mockGetAppConfig.mockResolvedValue({ skillSync: undefined, paths: {} });
    mockFindRoleByIdentifier.mockResolvedValue(null);

    const service = require('./sync');
    service.initializeGitHubSkillSync({ skillSync: undefined });

    await expect(
      mockRunnerDeps.grantPermission({
        principalType: 'public',
        principalId: null,
        resourceType: 'skill',
        resourceId: 'skill-id',
        accessRoleId: 'skill_viewer',
        grantedBy: 'system',
      }),
    ).rejects.toThrow('Role skill_viewer not found');
    expect(mockGrantPermission).not.toHaveBeenCalled();
  });
});
