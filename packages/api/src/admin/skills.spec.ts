import { SystemCapabilities } from '@librechat/data-schemas';
import type { ISkillSyncStatus } from '@librechat/data-schemas';
import type { NextFunction, Response } from 'express';
import { createAdminSkillsSyncAccess, createAdminSkillsSyncHandlers } from './skills';

function createResponse() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res as unknown as Response & {
    status: jest.Mock;
    json: jest.Mock;
  };
}

function createNext(): NextFunction & jest.Mock {
  return jest.fn() as NextFunction & jest.Mock;
}

type SourceStatus = ISkillSyncStatus & { credentialPresent: boolean };

function createSourceStatus(overrides: Partial<SourceStatus> = {}): SourceStatus {
  return {
    provider: 'github',
    sourceId: 'tenant-skills',
    tenantId: 'tenant-a',
    status: 'idle',
    credentialKey: 'github-skills-prod',
    credentialPresent: true,
    owner: 'LibreChat',
    repo: 'skills',
    ref: 'main',
    paths: ['skills'],
    syncedSkillCount: 0,
    syncedFileCount: 0,
    deletedSkillCount: 0,
    deletedFileCount: 0,
    skippedSkillCount: 0,
    skippedFileCount: 0,
    errorCode: undefined,
    errorMessage: undefined,
    startedAt: undefined,
    finishedAt: undefined,
    lastSuccessAt: undefined,
    lastFailureAt: undefined,
    createdAt: undefined,
    updatedAt: undefined,
    ...overrides,
  };
}

function createHandlers({
  statusErrorCode,
  statusErrorMessage,
  skippedSkillPath = 'skills/broken',
  skippedSkillErrorMessage = 'skills/broken/SKILL.md: malformed frontmatter',
}: {
  statusErrorCode?: string;
  statusErrorMessage?: string;
  skippedSkillPath?: string;
  skippedSkillErrorMessage?: string;
} = {}) {
  const runner = {
    getStatus: jest.fn(async () => ({
      enabled: true,
      intervalMinutes: 60,
      runOnStartup: false,
      sources: [
        createSourceStatus({
          skippedSkillCount: 1,
          skippedSkills: [
            {
              path: skippedSkillPath,
              name: 'broken',
              errorCode: 'SKILL_PARSE_FAILED',
              errorMessage: skippedSkillErrorMessage,
            },
          ],
          errorCode: statusErrorCode,
          errorMessage: statusErrorMessage,
        }),
      ],
      credentials: [
        {
          provider: 'github' as const,
          credentialKey: 'github-skills-prod',
          credentialPresent: true,
          tokenFingerprint: 'abc123',
        },
      ],
      fineGrainedTokenRecommendation: 'Use a fine-grained token.',
    })),
    runOnce: jest.fn(async () => ({
      status: 'completed' as const,
      sources: [
        createSourceStatus({
          status: 'partial',
          syncedSkillCount: 1,
          syncedFileCount: 2,
          skippedSkillCount: 1,
          skippedSkills: [
            {
              path: skippedSkillPath,
              name: 'broken',
              errorCode: 'SKILL_PARSE_FAILED',
              errorMessage: skippedSkillErrorMessage,
            },
          ],
          errorCode: statusErrorCode,
          errorMessage: statusErrorMessage,
        }),
      ],
    })),
  };
  const handlers = createAdminSkillsSyncHandlers({
    runner,
    upsertCredential: jest.fn(),
    deleteCredential: jest.fn(),
  });
  return { handlers, runner };
}

describe('createAdminSkillsSyncHandlers', () => {
  it('omits credential summaries and source credential metadata for tenant-scoped status reads', async () => {
    const { handlers } = createHandlers();
    const res = createResponse();

    await handlers.getSyncStatus(
      {
        user: { id: 'user-1', tenantId: 'tenant-a' },
        skillSyncCanReadCredentials: false,
      } as never,
      res,
    );

    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: [],
        sources: [
          expect.objectContaining({
            credentialKey: undefined,
            credentialPresent: false,
            owner: undefined,
            repo: undefined,
            ref: undefined,
            paths: undefined,
            /* Skipped entries name repository paths, so they are redacted with
               the rest of the source metadata; the bare count is not. */
            skippedSkillCount: 1,
            skippedSkills: undefined,
          }),
        ],
      }),
    );
  });

  it('filters tenant-scoped status reads to the request tenant and unscoped sources', async () => {
    const runner = {
      getStatus: jest.fn(async () => ({
        enabled: true,
        intervalMinutes: 60,
        runOnStartup: false,
        sources: [
          createSourceStatus({
            sourceId: 'tenant-a-source',
            tenantId: 'tenant-a',
            status: 'succeeded',
            syncedSkillCount: 4,
            syncedFileCount: 8,
          }),
          createSourceStatus({
            sourceId: 'shared-source',
            tenantId: undefined,
            status: 'succeeded',
            syncedSkillCount: 2,
            syncedFileCount: 3,
          }),
          createSourceStatus({
            sourceId: 'tenant-b-source',
            tenantId: 'tenant-b',
            status: 'failed',
            errorCode: 'PARSE_ERROR',
            errorMessage: 'Failed to parse skills/private-b/SKILL.md',
            syncedSkillCount: 7,
            syncedFileCount: 11,
            deletedSkillCount: 1,
            deletedFileCount: 2,
          }),
        ],
        credentials: [],
        fineGrainedTokenRecommendation: 'Use a fine-grained token.',
      })),
      runOnce: jest.fn(),
    };
    const handlers = createAdminSkillsSyncHandlers({
      runner,
      upsertCredential: jest.fn(),
      deleteCredential: jest.fn(),
    });
    const res = createResponse();

    await handlers.getSyncStatus(
      {
        user: { id: 'user-1', tenantId: 'tenant-a' },
        skillSyncCanReadCredentials: false,
      } as never,
      res,
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            sourceId: 'tenant-a-source',
            tenantId: 'tenant-a',
            status: 'succeeded',
            syncedSkillCount: 4,
            syncedFileCount: 8,
          }),
          expect.objectContaining({
            sourceId: 'shared-source',
            tenantId: undefined,
            status: 'succeeded',
            syncedSkillCount: 2,
            syncedFileCount: 3,
          }),
        ],
      }),
    );
    const response = res.json.mock.calls[0]?.[0] as { sources: Array<{ tenantId?: string }> };
    expect(response.sources).toHaveLength(2);
    expect(response.sources).toEqual([
      expect.objectContaining({ sourceId: 'tenant-a-source' }),
      expect.objectContaining({ sourceId: 'shared-source', tenantId: undefined }),
    ]);
  });

  it('redacts credential-related errors from tenant-scoped status reads', async () => {
    const { handlers } = createHandlers({
      statusErrorCode: 'MISSING_CREDENTIAL',
      statusErrorMessage: 'Missing GitHub token environment variable "GITHUB_SKILLS_TOKEN"',
    });
    const res = createResponse();

    await handlers.getSyncStatus(
      {
        user: { id: 'user-1', tenantId: 'tenant-a' },
        skillSyncCanReadCredentials: false,
      } as never,
      res,
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            errorCode: 'MISSING_CREDENTIAL',
            errorMessage: 'GitHub skill sync credentials are not available',
          }),
        ],
      }),
    );
  });

  it('redacts promoted skipped-skill paths from tenant-scoped status reads', async () => {
    const { handlers } = createHandlers({
      statusErrorCode: 'SKILL_PARSE_FAILED',
      statusErrorMessage: 'skills/broken/SKILL.md: malformed frontmatter',
    });
    const res = createResponse();

    await handlers.getSyncStatus(
      {
        user: { id: 'user-1', tenantId: 'tenant-a' },
        skillSyncCanReadCredentials: false,
      } as never,
      res,
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            errorCode: 'SKILL_PARSE_FAILED',
            errorMessage: 'One or more GitHub skills could not be synchronized',
            skippedSkills: undefined,
          }),
        ],
      }),
    );
  });

  it('does not mistake a promoted skipped-skill path for a credential failure', async () => {
    const errorMessage = 'skills/credential-helper/SKILL.md: malformed frontmatter';
    const { handlers } = createHandlers({
      statusErrorCode: 'SKILL_PARSE_FAILED',
      statusErrorMessage: errorMessage,
      skippedSkillPath: 'skills/credential-helper',
      skippedSkillErrorMessage: errorMessage,
    });
    const res = createResponse();

    await handlers.getSyncStatus(
      {
        user: { id: 'user-1', tenantId: 'tenant-a' },
        skillSyncCanReadCredentials: false,
      } as never,
      res,
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            errorCode: 'SKILL_PARSE_FAILED',
            errorMessage: 'One or more GitHub skills could not be synchronized',
          }),
        ],
      }),
    );
  });

  it('preserves a fatal source error that follows an earlier skipped skill', async () => {
    const { handlers } = createHandlers({
      statusErrorCode: 'GITHUB_RATE_LIMITED',
      statusErrorMessage: 'GitHub request failed with HTTP 403',
    });
    const res = createResponse();

    await handlers.getSyncStatus(
      {
        user: { id: 'user-1', tenantId: 'tenant-a' },
        skillSyncCanReadCredentials: false,
      } as never,
      res,
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            errorCode: 'GITHUB_RATE_LIMITED',
            errorMessage: 'GitHub request failed with HTTP 403',
            skippedSkills: undefined,
          }),
        ],
      }),
    );
  });

  it('includes credential summaries and source credential metadata for platform status reads', async () => {
    const { handlers } = createHandlers({
      statusErrorCode: 'MISSING_CREDENTIAL',
      statusErrorMessage: 'Missing GitHub credential "github-skills-prod"',
    });
    const res = createResponse();

    await handlers.getSyncStatus({ skillSyncCanReadCredentials: true } as never, res);

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: [expect.objectContaining({ credentialKey: 'github-skills-prod' })],
        sources: [
          expect.objectContaining({
            credentialKey: 'github-skills-prod',
            credentialPresent: true,
            owner: 'LibreChat',
            repo: 'skills',
            ref: 'main',
            paths: ['skills'],
            errorMessage: 'Missing GitHub credential "github-skills-prod"',
            skippedSkillCount: 1,
            skippedSkills: [
              expect.objectContaining({
                path: 'skills/broken',
                errorCode: 'SKILL_PARSE_FAILED',
              }),
            ],
          }),
        ],
      }),
    );
  });

  it('omits source credential metadata from tenant-scoped manual run responses', async () => {
    const { handlers } = createHandlers({
      statusErrorCode: 'MISSING_CREDENTIAL',
      statusErrorMessage: 'Missing GitHub credential "github-skills-prod"',
    });
    const res = createResponse();

    await handlers.runSync(
      {
        skillSyncAllowServerCredentials: true,
        skillSyncCanReadCredentials: false,
      } as never,
      res,
    );

    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [
          expect.objectContaining({
            credentialKey: undefined,
            credentialPresent: false,
            errorMessage: 'GitHub skill sync credentials are not available',
          }),
        ],
      }),
    );
  });
});

describe('createAdminSkillsSyncAccess', () => {
  const baseSkillSync = {
    github: {
      enabled: true,
      intervalMinutes: 60,
      runOnStartup: false,
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

  function createAccess({
    hasCapability = jest.fn().mockResolvedValue(true),
    getAppConfig = jest.fn().mockResolvedValue({ skillSync: undefined }),
  }: {
    hasCapability?: jest.Mock;
    getAppConfig?: jest.Mock;
  } = {}) {
    return {
      access: createAdminSkillsSyncAccess({ getAppConfig, hasCapability }),
      getAppConfig,
      hasCapability,
    };
  }

  it('attaches the base skill sync config for override comparison', async () => {
    const getAppConfig = jest.fn().mockResolvedValue({ skillSync: baseSkillSync });
    const { access } = createAccess({ getAppConfig });
    const req = { config: { skillSync: undefined, config: { endpoints: {} } } };
    const res = createResponse();
    const next = createNext();

    await access.attachBaseSkillSyncConfig(req as never, res, next);

    expect(getAppConfig).toHaveBeenCalledWith({ baseOnly: true });
    expect(req.config.config).toEqual({ endpoints: {}, skillSync: baseSkillSync });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('marks credential metadata hidden for tenant-scoped status reads', async () => {
    const hasCapability = jest.fn(
      async (user: { tenantId?: string }, capability: string): Promise<boolean> => {
        if (capability === SystemCapabilities.READ_SKILLS) {
          return Boolean(user.tenantId);
        }
        return true;
      },
    );
    const { access } = createAccess({ hasCapability });
    const req = { user: { id: 'user-1', role: 'ADMIN', tenantId: 'tenant-a' } };
    const res = createResponse();
    const next = createNext();

    await access.requireReadSkills(req as never, res, next);
    await access.attachCredentialReadAccess(req as never, res, next);

    expect(req).toMatchObject({
      skillSyncCanReadCredentials: false,
      skillSyncAllowServerCredentials: false,
    });
    expect(hasCapability).toHaveBeenCalledWith(
      { id: 'user-1', role: 'ADMIN', tenantId: 'tenant-a' },
      SystemCapabilities.READ_SKILLS,
    );
    expect(hasCapability).toHaveBeenCalledWith(
      { id: 'user-1', role: 'ADMIN' },
      SystemCapabilities.READ_SKILLS,
    );
  });

  it('prevents tenant admins from running overrides that require server credentials', async () => {
    const tenantSkillSync = {
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
    const hasCapability = jest.fn(
      async (user: { tenantId?: string }, capability: string): Promise<boolean> => {
        if (capability === SystemCapabilities.MANAGE_SKILLS) {
          return Boolean(user.tenantId);
        }
        return true;
      },
    );
    const { access } = createAccess({ hasCapability });
    const req = {
      user: { id: 'user-1', role: 'ADMIN', tenantId: 'tenant-a' },
      config: { skillSync: tenantSkillSync, config: {} },
    };
    const res = createResponse();
    const next = createNext();

    await access.requireSyncRunCapability(req as never, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      message: 'Tenant-scoped manual skill sync requires platform credential access',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('prevents tenant admins from manually running base skill sync config', async () => {
    const hasCapability = jest.fn(
      async (user: { tenantId?: string }, capability: string): Promise<boolean> => {
        if (capability === SystemCapabilities.MANAGE_SKILLS) {
          return Boolean(user.tenantId);
        }
        return true;
      },
    );
    const { access } = createAccess({ hasCapability });
    const req = {
      user: { id: 'user-1', role: 'ADMIN', tenantId: 'tenant-a' },
      config: { skillSync: baseSkillSync, config: { skillSync: baseSkillSync } },
    };
    const res = createResponse();
    const next = createNext();

    await access.requireSyncRunCapability(req as never, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ message: 'Forbidden' });
    expect(next).not.toHaveBeenCalled();
  });

  it('allows platform admins to manually run base skill sync config with server credentials', async () => {
    const { access } = createAccess();
    const req = {
      user: { id: 'user-1', role: 'ADMIN', tenantId: 'tenant-a' },
      config: { skillSync: baseSkillSync, config: { skillSync: baseSkillSync } },
    };
    const res = createResponse();
    const next = createNext();

    await access.requireSyncRunCapability(req as never, res, next);

    expect(req).toMatchObject({
      skillSyncAllowServerCredentials: true,
      skillSyncCanReadCredentials: true,
    });
    expect(next).toHaveBeenCalledTimes(1);
  });
});
