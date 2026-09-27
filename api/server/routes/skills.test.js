const express = require('express');
const request = require('supertest');
const JSZip = require('jszip');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    mergeFileConfig: jest.fn((dynamic) => {
      const skillFileSizeLimit = dynamic?.skills?.fileSizeLimit;
      return {
        ...actual.fileConfig,
        ...dynamic,
        skills: {
          ...(actual.fileConfig.skills ?? { fileSizeLimit: 50 * 1024 * 1024 }),
          ...(skillFileSizeLimit !== undefined
            ? { fileSizeLimit: skillFileSizeLimit * 1024 * 1024 }
            : {}),
        },
      };
    }),
  };
});

const {
  SystemRoles,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
} = require('librechat-data-provider');
const { CONTENT_TRAVERSAL_MAX_DEPTH } = require('@librechat/api');

let mockFileConfig;
let mockFilters;
const mockMaybeRunGitHubSkillSyncForRequest = jest.fn(async () => false);

jest.mock('~/server/services/Config', () => ({
  getCachedTools: jest.fn().mockResolvedValue({}),
  getAppConfig: jest.fn().mockResolvedValue({
    fileStrategy: 'local',
    paths: { uploads: '/tmp/uploads', images: '/tmp/images' },
  }),
}));

jest.mock('~/server/middleware/config/app', () => (req, _res, next) => {
  req.config = {
    fileStrategy: 'local',
    paths: { uploads: '/tmp/uploads', images: '/tmp/images' },
    fileConfig: mockFileConfig,
    filters: mockFilters,
  };
  next();
});

jest.mock('~/server/services/Files/strategies', () => ({
  getStrategyFunctions: jest.fn().mockReturnValue({
    saveBuffer: jest.fn().mockResolvedValue('/uploads/test/file.txt'),
    getDownloadStream: jest.fn().mockResolvedValue({
      pipe: jest.fn(),
      on: jest.fn(),
      [Symbol.asyncIterator]: async function* () {
        yield Buffer.from('test content');
      },
    }),
  }),
}));

jest.mock('~/server/utils/getFileStrategy', () => ({
  getFileStrategy: jest.fn().mockReturnValue('local'),
}));

jest.mock('~/server/services/Skills/sync', () => ({
  maybeRunGitHubSkillSyncForRequest: mockMaybeRunGitHubSkillSyncForRequest,
}));

jest.mock('~/models', () => {
  const mongoose = require('mongoose');
  const { createMethods } = require('@librechat/data-schemas');
  const methods = createMethods(mongoose, {
    removeAllPermissions: async ({ resourceType, resourceId }) => {
      const AclEntry = mongoose.models.AclEntry;
      if (AclEntry) {
        await AclEntry.deleteMany({ resourceType, resourceId });
      }
    },
  });
  // Override getRoleByName to return a permissive SKILLS capability block for all
  // test users. The real role seeding relies on `initializeRoles` which this
  // suite intentionally skips to keep setup minimal.
  return {
    ...methods,
    getRoleByName: jest.fn(),
  };
});

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  canAccessSkillResource: jest.requireActual('~/server/middleware').canAccessSkillResource,
}));

let app;
let mongoServer;
let skillRoutes;
let Skill;
let SkillFile;
let AclEntry;
let AccessRole;
let User;
let testUsers;
let testRoles;
let grantPermission;
let currentTestUser;

function setTestUser(user) {
  currentTestUser = user;
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const dbModels = require('~/db/models');
  Skill = dbModels.Skill;
  SkillFile = dbModels.SkillFile;
  AclEntry = dbModels.AclEntry;
  AccessRole = dbModels.AccessRole;
  User = dbModels.User;

  const permissionService = require('~/server/services/PermissionService');
  grantPermission = permissionService.grantPermission;

  await setupTestData();

  app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    if (currentTestUser) {
      req.user = {
        ...(currentTestUser.toObject ? currentTestUser.toObject() : currentTestUser),
        id: currentTestUser._id.toString(),
        _id: currentTestUser._id,
        name: currentTestUser.name,
        role: currentTestUser.role,
      };
    }
    next();
  });

  currentTestUser = testUsers.owner;
  skillRoutes = require('./skills');
  app.use('/api/skills', skillRoutes);
});

afterEach(async () => {
  await Skill.deleteMany({});
  await SkillFile.deleteMany({});
  await AclEntry.deleteMany({});
  currentTestUser = testUsers.owner;
  mockFileConfig = undefined;
  mockFilters = undefined;
  mockMaybeRunGitHubSkillSyncForRequest.mockClear();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  jest.clearAllMocks();
});

async function setupTestData() {
  testRoles = {
    viewer: await AccessRole.create({
      accessRoleId: AccessRoleIds.SKILL_VIEWER,
      name: 'Viewer',
      resourceType: ResourceType.SKILL,
      permBits: PermissionBits.VIEW,
    }),
    editor: await AccessRole.create({
      accessRoleId: AccessRoleIds.SKILL_EDITOR,
      name: 'Editor',
      resourceType: ResourceType.SKILL,
      permBits: PermissionBits.VIEW | PermissionBits.EDIT,
    }),
    owner: await AccessRole.create({
      accessRoleId: AccessRoleIds.SKILL_OWNER,
      name: 'Owner',
      resourceType: ResourceType.SKILL,
      permBits:
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE,
    }),
  };

  testUsers = {
    owner: await User.create({
      name: 'Skill Owner',
      email: 'skill-owner@test.com',
      role: SystemRoles.USER,
    }),
    editor: await User.create({
      name: 'Skill Editor',
      email: 'skill-editor@test.com',
      role: SystemRoles.USER,
    }),
    noAccess: await User.create({
      name: 'No Access',
      email: 'no-access@test.com',
      role: SystemRoles.USER,
    }),
  };

  const { getRoleByName } = require('~/models');
  getRoleByName.mockImplementation((roleName) => {
    if (roleName === SystemRoles.USER || roleName === SystemRoles.ADMIN) {
      return {
        permissions: {
          SKILLS: {
            USE: true,
            CREATE: true,
            SHARE: true,
            SHARE_PUBLIC: true,
          },
        },
      };
    }
    return null;
  });
}

async function createSkillAsOwner(overrides = {}) {
  // Description is deliberately kept above the 20-char short-description
  // warning threshold so existing tests don't trip the coaching warning.
  const res = await request(app)
    .post('/api/skills')
    .send({
      name: 'demo-skill',
      description: 'A small demo skill used in routing integration tests.',
      body: '# Demo',
      ...overrides,
    });
  return res;
}

function createOverflowingFrontmatter(visible) {
  const root = { visible };
  let current = root;
  for (let depth = 0; depth < CONTENT_TRAVERSAL_MAX_DEPTH; depth++) {
    current.nested = {};
    current = current.nested;
  }
  current.nested = { hidden: 'PRIVATE-HIDDEN' };
  return root;
}

describe('Skill routes', () => {
  let errSpy;
  beforeEach(() => {
    errSpy = jest.spyOn(console, 'error').mockImplementation();
  });
  afterEach(() => errSpy.mockRestore());

  describe('POST /api/skills', () => {
    it('creates a skill and grants SKILL_OWNER ACL', async () => {
      const res = await createSkillAsOwner();
      expect(res.status).toBe(201);
      expect(res.body._id).toBeDefined();
      expect(res.body.version).toBe(1);
      expect(res.body.name).toBe('demo-skill');
      // No warnings on a description that comfortably clears the threshold.
      expect(res.body.warnings).toBeUndefined();

      const acl = await AclEntry.findOne({
        resourceType: ResourceType.SKILL,
        resourceId: res.body._id,
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
      });
      expect(acl).toBeTruthy();
      expect(acl.roleId.toString()).toBe(testRoles.owner._id.toString());
    });

    it('attaches a TOO_SHORT warning on create when description is under 20 chars', async () => {
      const res = await createSkillAsOwner({
        name: 'short-desc-skill',
        description: 'Too short.',
      });
      expect(res.status).toBe(201);
      expect(res.body._id).toBeDefined();
      expect(Array.isArray(res.body.warnings)).toBe(true);
      expect(res.body.warnings).toEqual([
        expect.objectContaining({
          field: 'description',
          code: 'TOO_SHORT',
          severity: 'warning',
        }),
      ]);
    });

    it('rejects names starting with reserved brand prefixes', async () => {
      const anthropic = await createSkillAsOwner({ name: 'anthropic-helper' });
      expect(anthropic.status).toBe(400);
      const claude = await createSkillAsOwner({ name: 'claude-helper' });
      expect(claude.status).toBe(400);
    });

    it('allows names that merely contain reserved brand words as substrings', async () => {
      const res = await createSkillAsOwner({ name: 'research-anthropic-helper' });
      expect(res.status).toBe(201);
    });

    it('rejects reserved CLI command names', async () => {
      const res = await createSkillAsOwner({ name: 'settings' });
      expect(res.status).toBe(400);
    });

    it('accepts frontmatter with unknown keys and warns about them', async () => {
      const res = await createSkillAsOwner({
        name: 'unknown-key-frontmatter-skill',
        frontmatter: { 'not-a-real-key': 'value' },
      });
      expect(res.status).toBe(201);
      expect(res.body.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'UNKNOWN_KEY', severity: 'warning' }),
        ]),
      );
    });

    it('rejects malformed frontmatter with 400', async () => {
      const res = await createSkillAsOwner({
        name: 'bad-frontmatter-skill',
        frontmatter: { 'user-invocable': 'yes' },
      });
      expect(res.status).toBe(400);
      expect(res.body.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'INVALID_TYPE' })]),
      );
    });

    it('rejects missing description with 400', async () => {
      const res = await request(app).post('/api/skills').send({ name: 'x-skill', body: '' });
      expect(res.status).toBe(400);
    });

    it('rejects invalid name with 400 validation failure', async () => {
      const res = await createSkillAsOwner({ name: 'BAD NAME' });
      expect(res.status).toBe(400);
      expect(res.body.issues).toBeDefined();
    });

    it('rejects duplicate names with 409', async () => {
      const a = await createSkillAsOwner();
      expect(a.status).toBe(201);
      const b = await createSkillAsOwner();
      expect(b.status).toBe(409);
    });

    it('blocks configured skill fields before creating a skill', async () => {
      mockFilters = {
        skills: {
          pii: {
            fields: ['instructions'],
            starterPatterns: [],
            customPatterns: [
              { id: 'private_token', label: 'private token', regex: 'PRIVATE-\\d+' },
            ],
          },
        },
      };

      const res = await createSkillAsOwner({ body: 'Use PRIVATE-1234 to authenticate.' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'skill',
          field: 'instructions',
        }),
      );
      expect(await Skill.countDocuments()).toBe(0);
    });

    it('blocks an inspected partial frontmatter fragment before traversal exhaustion', async () => {
      mockFilters = {
        skills: {
          pii: {
            fields: ['frontmatter'],
            starterPatterns: [],
            customPatterns: [
              { id: 'partial_content', label: 'partial content', regex: 'PRIVATE-VISIBLE' },
            ],
          },
        },
      };

      const res = await createSkillAsOwner({
        frontmatter: createOverflowingFrontmatter('PRIVATE-VISIBLE'),
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'skill',
          field: 'frontmatter',
        }),
      );
      expect(await Skill.countDocuments()).toBe(0);
    });

    it('fails closed when selected skill frontmatter cannot be fully inspected', async () => {
      mockFilters = {
        skills: {
          pii: {
            fields: ['frontmatter'],
            starterPatterns: [],
            customPatterns: [
              { id: 'protected_content', label: 'protected content', regex: 'PRIVATE-NOT-PRESENT' },
            ],
          },
        },
      };

      const res = await createSkillAsOwner({
        frontmatter: createOverflowingFrontmatter('safe visible value'),
      });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'content_filter_uninspectable',
        message: 'Submitted content could not be completely inspected before processing.',
        source: 'skill',
        field: 'frontmatter',
      });
      expect(await Skill.countDocuments()).toBe(0);
    });

    it('does not fail closed on oversized frontmatter when only another field is selected', async () => {
      mockFilters = {
        skills: {
          pii: {
            fields: ['description'],
            starterPatterns: [],
            customPatterns: [
              { id: 'protected_description', label: 'protected description', regex: 'PRIVATE' },
            ],
          },
        },
      };

      const res = await createSkillAsOwner({
        description: 'A safe skill description used for traversal coverage.',
        frontmatter: createOverflowingFrontmatter('PRIVATE-VISIBLE'),
      });

      expect(res.status).toBe(400);
      expect(res.body.error).not.toBe('content_filter_uninspectable');
      expect(res.body.issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ code: 'INVALID_SHAPE' })]),
      );
      expect(await Skill.countDocuments()).toBe(0);
    });

    it('honors skill field granularity', async () => {
      mockFilters = {
        skills: {
          pii: {
            fields: ['description'],
            starterPatterns: [],
            customPatterns: [
              { id: 'private_token', label: 'private token', regex: 'PRIVATE-\\d+' },
            ],
          },
        },
      };

      const res = await createSkillAsOwner({ body: 'Use PRIVATE-1234 to authenticate.' });

      expect(res.status).toBe(201);
    });
  });

  describe('POST /api/skills/import', () => {
    it('enforces fileConfig.skills.fileSizeLimit before import handling', async () => {
      mockFileConfig = {
        skills: {
          fileSizeLimit: 1,
        },
      };

      const res = await request(app)
        .post('/api/skills/import')
        .attach('file', Buffer.alloc(2 * 1024 * 1024), {
          filename: 'too-large.skill',
          contentType: 'application/zip',
        });

      const { mergeFileConfig } = require('librechat-data-provider');
      expect(mergeFileConfig).toHaveBeenCalledWith(mockFileConfig);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/file too large/i);
    });

    it('persists storage metadata for imported skill files', async () => {
      const savedFilepath =
        'https://cdn.example.com/r/us-east-2/uploads/user123/imported-script.sh';
      const saveBuffer = jest.fn().mockResolvedValue(savedFilepath);
      const { getFileStrategy } = require('~/server/utils/getFileStrategy');
      const { getStrategyFunctions } = require('~/server/services/Files/strategies');
      getFileStrategy.mockReturnValueOnce('cloudfront');
      getStrategyFunctions.mockReturnValueOnce({ saveBuffer });

      const zip = new JSZip();
      zip.file(
        'SKILL.md',
        [
          '---',
          'name: imported-skill',
          'description: Imported skill description for route tests.',
          '---',
          '# Imported Skill',
        ].join('\n'),
      );
      zip.file('scripts/imported-script.sh', 'echo imported');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      const res = await request(app).post('/api/skills/import').attach('file', buffer, {
        filename: 'imported-skill.skill',
        contentType: 'application/zip',
      });

      expect(res.status).toBe(201);
      expect(saveBuffer).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: testUsers.owner._id.toString(),
          basePath: 'uploads',
        }),
      );

      const savedFile = await SkillFile.findOne({
        relativePath: 'scripts/imported-script.sh',
      }).lean();
      expect(savedFile).toEqual(
        expect.objectContaining({
          filepath: savedFilepath,
          source: 'cloudfront',
          storageKey: 'r/us-east-2/uploads/user123/imported-script.sh',
          storageRegion: 'us-east-2',
        }),
      );
    });

    it('rolls back the skill, files, ACL, and stored blob when a bundled file fails', async () => {
      const saveBuffer = jest.fn().mockResolvedValue('/uploads/test/queries.sql');
      const deleteFile = jest.fn().mockResolvedValue(undefined);
      const { getStrategyFunctions } = require('~/server/services/Files/strategies');
      /** Both the write and the rollback delete resolve a strategy, so the
       *  override outlives a single call and is restored below. */
      const defaultStrategies = getStrategyFunctions();
      getStrategyFunctions.mockReturnValue({ saveBuffer, deleteFile });

      const zip = new JSZip();
      zip.file(
        'SKILL.md',
        [
          '---',
          'name: partial-import',
          'description: Imported skill that loses one bundled file.',
          '---',
          '# Partial Import',
        ].join('\n'),
      );
      zip.file('queries.sql', 'select 1;');
      /** A space is outside the stored path charset, so this entry can never
       *  persist — the import must fail instead of dropping it silently. */
      zip.file('references/region mapping.md', '# regions');
      const buffer = await zip.generateAsync({ type: 'nodebuffer' });

      const res = await request(app).post('/api/skills/import').attach('file', buffer, {
        filename: 'partial-import.skill',
        contentType: 'application/zip',
      });
      getStrategyFunctions.mockReturnValue(defaultStrategies);

      expect(res.status).toBe(422);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'skill_import_incomplete',
          failedFiles: [{ path: 'references/region mapping.md', reason: 'invalid_path' }],
        }),
      );
      expect(await Skill.countDocuments({ name: 'partial-import' })).toBe(0);
      expect(await SkillFile.countDocuments()).toBe(0);
      expect(await AclEntry.countDocuments({ resourceType: ResourceType.SKILL })).toBe(0);
      expect(deleteFile).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ filepath: '/uploads/test/queries.sql' }),
      );
    });

    it('blocks filtered Markdown before creating the imported skill', async () => {
      mockFilters = {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [
              { id: 'private_token', label: 'private token', regex: 'PRIVATE-\\d+' },
            ],
          },
        },
      };

      const markdown = [
        '---',
        'name: filtered-import',
        'description: Imported skill with enough description.',
        '---',
        'Use PRIVATE-1234 to authenticate.',
      ].join('\n');
      const res = await request(app)
        .post('/api/skills/import')
        .attach('file', Buffer.from(markdown), {
          filename: 'filtered-import.md',
          contentType: 'text/markdown',
        });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'file',
          field: 'extracted_text',
        }),
      );
      expect(await Skill.countDocuments()).toBe(0);
      expect(await SkillFile.countDocuments()).toBe(0);
    });
  });

  describe('GET /api/skills', () => {
    it('returns only skills the caller can access', async () => {
      const mine = await createSkillAsOwner({ name: 'mine-skill' });
      expect(mine.status).toBe(201);

      setTestUser(testUsers.noAccess);
      const other = await createSkillAsOwner({ name: 'other-skill' });
      expect(other.status).toBe(201);
      // Note: the user middleware grants owner perms to whichever user created, so both
      // users see their own skill only.

      setTestUser(testUsers.owner);
      const res = await request(app).get('/api/skills');
      expect(res.status).toBe(200);
      expect(mockMaybeRunGitHubSkillSyncForRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({ fileStrategy: 'local' }),
          user: expect.objectContaining({ id: testUsers.owner._id.toString() }),
        }),
      );
      expect(res.body.skills.length).toBe(1);
      expect(res.body.skills[0].name).toBe('mine-skill');
    });
  });

  describe('GET /api/skills/:id', () => {
    it('returns 403 when the user has no access', async () => {
      const created = await createSkillAsOwner();
      expect(created.status).toBe(201);
      setTestUser(testUsers.noAccess);
      const res = await request(app).get(`/api/skills/${created.body._id}`);
      expect(res.status).toBe(403);
    });

    it('returns the skill to the owner with isPublic flag', async () => {
      const created = await createSkillAsOwner();
      const res = await request(app).get(`/api/skills/${created.body._id}`);
      expect(res.status).toBe(200);
      expect(res.body.name).toBe('demo-skill');
      expect(res.body.isPublic).toBe(false);
    });
  });

  describe('PATCH /api/skills/:id (optimistic concurrency)', () => {
    it('updates with correct expectedVersion and bumps version', async () => {
      const created = await createSkillAsOwner();
      const res = await request(app)
        .patch(`/api/skills/${created.body._id}`)
        .send({ expectedVersion: 1, description: 'Updated description' });
      expect(res.status).toBe(200);
      expect(res.body.version).toBe(2);
      expect(res.body.description).toBe('Updated description');
    });

    it('returns 409 on stale expectedVersion', async () => {
      const created = await createSkillAsOwner();
      const first = await request(app)
        .patch(`/api/skills/${created.body._id}`)
        .send({ expectedVersion: 1, description: 'First' });
      expect(first.status).toBe(200);

      const stale = await request(app)
        .patch(`/api/skills/${created.body._id}`)
        .send({ expectedVersion: 1, description: 'Stale' });
      expect(stale.status).toBe(409);
      expect(stale.body.error).toBe('skill_version_conflict');
      expect(stale.body.current.version).toBe(2);
    });

    it('rejects updates without expectedVersion', async () => {
      const created = await createSkillAsOwner();
      const res = await request(app)
        .patch(`/api/skills/${created.body._id}`)
        .send({ description: 'no version' });
      expect(res.status).toBe(400);
    });

    it('returns 403 for a user without EDIT permission', async () => {
      const created = await createSkillAsOwner();
      setTestUser(testUsers.noAccess);
      const res = await request(app)
        .patch(`/api/skills/${created.body._id}`)
        .send({ expectedVersion: 1, description: 'nope' });
      expect(res.status).toBe(403);
    });

    it('blocks configured content before updating a skill', async () => {
      const created = await createSkillAsOwner();
      mockFilters = {
        skills: {
          pii: {
            fields: ['description'],
            starterPatterns: [],
            customPatterns: [
              { id: 'private_token', label: 'private token', regex: 'PRIVATE-\\d+' },
            ],
          },
        },
      };

      const res = await request(app)
        .patch(`/api/skills/${created.body._id}`)
        .send({ expectedVersion: 1, description: 'Contains PRIVATE-1234.' });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'skill',
          field: 'description',
        }),
      );
      const persisted = await Skill.findById(created.body._id).lean();
      expect(persisted.version).toBe(1);
      expect(persisted.description).toBe('A small demo skill used in routing integration tests.');
    });
  });

  describe('DELETE /api/skills/:id', () => {
    it('deletes and cascades ACL entries', async () => {
      const created = await createSkillAsOwner();
      const res = await request(app).delete(`/api/skills/${created.body._id}`);
      expect(res.status).toBe(200);
      expect(res.body.deleted).toBe(true);

      const remainingAcl = await AclEntry.countDocuments({
        resourceType: ResourceType.SKILL,
        resourceId: created.body._id,
      });
      expect(remainingAcl).toBe(0);
    });

    it('returns 403 for a non-owner', async () => {
      const created = await createSkillAsOwner();
      setTestUser(testUsers.noAccess);
      const res = await request(app).delete(`/api/skills/${created.body._id}`);
      expect(res.status).toBe(403);
    });
  });

  describe('GET /api/skills/:id/files', () => {
    it('returns an empty list for a skill with no files', async () => {
      const created = await createSkillAsOwner();
      const res = await request(app).get(`/api/skills/${created.body._id}/files`);
      expect(res.status).toBe(200);
      expect(res.body.files).toEqual([]);
    });
  });

  describe('POST /api/skills/:id/files (live)', () => {
    it('replaces a nested text file and clears the old cached content', async () => {
      const { Readable } = require('stream');
      const { getStrategyFunctions } = require('~/server/services/Files/strategies');
      const { updateSkillFileContent } = require('~/models');
      const originalStrategy = getStrategyFunctions.getMockImplementation();
      const stored = new Map();
      const saveBuffer = jest.fn(async ({ buffer, fileName }) => {
        const filepath = `/uploads/${fileName}`;
        stored.set(filepath, Buffer.from(buffer));
        return filepath;
      });
      const getDownloadStream = jest.fn(async (_req, filepath) => {
        const buffer = stored.get(filepath);
        if (!buffer) {
          throw new Error('File not found in test storage');
        }
        return Readable.from([buffer]);
      });
      getStrategyFunctions.mockReturnValue({ saveBuffer, getDownloadStream });

      try {
        const created = await createSkillAsOwner();
        const skillId = created.body._id;
        const relativePath = 'references/queries.md';
        const url = `/api/skills/${skillId}/files`;
        const readUrl = `${url}/${encodeURIComponent(relativePath)}`;
        const upload = (content) =>
          request(app)
            .post(url)
            .field('relativePath', relativePath)
            .attach('file', Buffer.from(content), {
              filename: 'queries.md',
              contentType: 'text/markdown',
            });

        const original = await upload('first revision');
        expect(original.status).toBe(200);
        await updateSkillFileContent(skillId, relativePath, {
          content: 'first revision',
          isBinary: false,
        });
        const cached = await request(app).get(readUrl);
        expect(cached.status).toBe(200);
        expect(cached.body.content).toBe('first revision');

        const replacement = await upload('saved revision');
        expect(replacement.status).toBe(200);
        expect(replacement.body.relativePath).toBe(relativePath);
        const persisted = await request(app).get(readUrl);
        expect(persisted.status).toBe(200);
        expect(persisted.body.content).toBe('saved revision');
        expect(getDownloadStream).toHaveBeenCalledTimes(1);
        expect(saveBuffer).toHaveBeenCalledTimes(2);
      } finally {
        getStrategyFunctions.mockImplementation(originalStrategy);
      }
    });

    it('rejects an editor revision after a newer write and never recreates a deleted file', async () => {
      const created = await createSkillAsOwner();
      const url = `/api/skills/${created.body._id}/files`;
      const upload = (text, expectedFileId) => {
        const req = request(app)
          .post(expectedFileId ? `${url}/references/revision.md` : url)
          .field('relativePath', 'references/revision.md');
        if (expectedFileId) req.field('expectedFileId', expectedFileId);
        return req.attach('file', Buffer.from(text), {
          filename: 'revision.md',
          contentType: 'text/markdown',
        });
      };
      const initial = await upload('first');
      expect(initial.status).toBe(200);
      const read = await request(app).get(`${url}/references/revision.md`);
      expect(read.body.fileId).toBe(initial.body.file_id);
      const replaced = await upload('newer', initial.body.file_id);
      expect(replaced.status).toBe(200);
      expect((await upload('stale', initial.body.file_id)).status).toBe(409);
      const stored = await SkillFile.findOne({ skillId: created.body._id });
      expect(stored.file_id).toBe(replaced.body.file_id);
      await request(app).delete(`${url}/references/revision.md`);
      expect((await upload('resurrect', replaced.body.file_id)).status).toBe(409);
      expect(await SkillFile.countDocuments({ skillId: created.body._id })).toBe(0);
    });

    it.each(['github', 'notion'])(
      'rejects uploads to %s-managed skills before storing bytes',
      async (source) => {
        const created = await createSkillAsOwner();
        await Skill.updateOne({ _id: created.body._id }, { $set: { source } });
        const { getStrategyFunctions } = require('~/server/services/Files/strategies');
        const saveBuffer = getStrategyFunctions('local').saveBuffer;
        saveBuffer.mockClear();
        const response = await request(app)
          .post(`/api/skills/${created.body._id}/files`)
          .field('relativePath', 'references/managed.md')
          .attach('file', Buffer.from('local draft'), {
            filename: 'managed.md',
            contentType: 'text/markdown',
          });
        expect(response.status).toBe(403);
        expect(saveBuffer).not.toHaveBeenCalled();
        expect(await SkillFile.countDocuments()).toBe(0);
      },
    );

    it('treats legacy skills without a stored source as inline for reads and file edits', async () => {
      const created = await createSkillAsOwner();
      const skillId = created.body._id;
      const id = new mongoose.Types.ObjectId(skillId);
      await Skill.collection.updateOne({ _id: id }, { $unset: { source: '' } });
      expect(await Skill.collection.findOne({ _id: id })).not.toHaveProperty('source');

      const detail = await request(app).get(`/api/skills/${skillId}`);
      expect(detail.status).toBe(200);
      expect(detail.body.source).toBe('inline');
      const list = await request(app).get('/api/skills');
      expect(list.status).toBe(200);
      expect(list.body.skills.find((entry) => entry._id === skillId).source).toBe('inline');

      const url = `/api/skills/${skillId}/files`;
      const first = await request(app)
        .post(url)
        .field('relativePath', 'references/legacy.md')
        .attach('file', Buffer.from('first'), {
          filename: 'legacy.md',
          contentType: 'text/markdown',
        });
      expect(first.status).toBe(200);
      const edited = await request(app)
        .post(`${url}/references/legacy.md`)
        .field('relativePath', 'references/legacy.md')
        .field('expectedFileId', first.body.file_id)
        .attach('file', Buffer.from('edited'), {
          filename: 'legacy.md',
          contentType: 'text/markdown',
        });
      expect(edited.status).toBe(200);
      expect(await SkillFile.findOne({ skillId }).lean()).toMatchObject({
        file_id: edited.body.file_id,
      });
    });

    it('rejects an agent replacement captured before a newer browser edit', async () => {
      const { getSkillToolDeps } = require('~/server/services/Endpoints/agents/skillDeps');
      const { getStrategyFunctions } = require('~/server/services/Files/strategies');
      const originalStrategy = getStrategyFunctions.getMockImplementation();
      const created = await createSkillAsOwner();
      const skillId = created.body._id;
      const relativePath = 'references/shared.md';
      const url = `/api/skills/${skillId}/files`;
      const initial = await request(app)
        .post(url)
        .field('relativePath', relativePath)
        .attach('file', Buffer.from('original'), {
          filename: 'shared.md',
          contentType: 'text/markdown',
        });
      expect(initial.status).toBe(200);
      const agentRead = await getSkillToolDeps().getSkillFileByPath(skillId, relativePath);
      const capturedVersion = (await Skill.findById(skillId).lean()).version;
      expect(agentRead.file_id).toBe(initial.body.file_id);

      const browser = await request(app)
        .post(`${url}/references/shared.md`)
        .field('relativePath', relativePath)
        .field('expectedFileId', agentRead.file_id)
        .attach('file', Buffer.from('browser winner'), {
          filename: 'shared.md',
          contentType: 'text/markdown',
        });
      expect(browser.status).toBe(200);
      expect((await Skill.findById(skillId).lean()).version).toBe(capturedVersion + 1);
      const winner = await SkillFile.findOne({ skillId, relativePath }).lean();

      const saveBuffer = jest.fn(async ({ fileName }) => `/uploads/${fileName}`);
      const deleteFile = jest.fn(async () => undefined);
      getStrategyFunctions.mockReturnValue({ saveBuffer, deleteFile });
      try {
        await expect(
          getSkillToolDeps().saveSkillFileContent({
            req: {
              user: { id: testUsers.owner._id.toString(), _id: testUsers.owner._id },
              config: { fileStrategy: 'local' },
            },
            skillId,
            relativePath,
            content: 'stale agent edit',
            mimeType: 'text/markdown',
            expectedFileId: agentRead.file_id,
          }),
        ).rejects.toMatchObject({ code: 'SKILL_FILE_CONFLICT' });
        expect(saveBuffer).not.toHaveBeenCalled();
        expect(deleteFile).not.toHaveBeenCalled();
        expect(await SkillFile.findOne({ skillId, relativePath }).lean()).toMatchObject({
          file_id: browser.body.file_id,
          filepath: winner.filepath,
        });
        expect((await Skill.findById(skillId).lean()).version).toBe(capturedVersion + 1);
      } finally {
        getStrategyFunctions.mockImplementation(originalStrategy);
      }
    });

    it('rejects and cleans an agent upload when a browser edit lands during storage', async () => {
      const { getSkillToolDeps } = require('~/server/services/Endpoints/agents/skillDeps');
      const { getStrategyFunctions } = require('~/server/services/Files/strategies');
      const originalStrategy = getStrategyFunctions.getMockImplementation();
      const created = await createSkillAsOwner();
      const skillId = created.body._id;
      const relativePath = 'references/overlap.md';
      const url = `/api/skills/${skillId}/files`;
      const initial = await request(app)
        .post(url)
        .field('relativePath', relativePath)
        .attach('file', Buffer.from('initial'), {
          filename: 'overlap.md',
          contentType: 'text/markdown',
        });
      expect(initial.status).toBe(200);
      const agentRead = await getSkillToolDeps().getSkillFileByPath(skillId, relativePath);
      const agentReq = {
        user: { id: testUsers.owner._id.toString(), _id: testUsers.owner._id },
        config: { fileStrategy: 'local' },
      };
      let browserRevision;
      const deleteFile = jest.fn(async () => undefined);
      const saveBuffer = jest.fn(async ({ fileName }) => {
        if (saveBuffer.mock.calls.length === 1) {
          const browser = await request(app)
            .post(`${url}/references/overlap.md`)
            .field('relativePath', relativePath)
            .field('expectedFileId', agentRead.file_id)
            .attach('file', Buffer.from('browser wins'), {
              filename: 'overlap.md',
              contentType: 'text/markdown',
            });
          expect(browser.status).toBe(200);
          browserRevision = browser.body.file_id;
        }
        return `/uploads/${fileName}`;
      });
      getStrategyFunctions.mockReturnValue({ saveBuffer, deleteFile });
      try {
        await expect(
          getSkillToolDeps().saveSkillFileContent({
            req: agentReq,
            skillId,
            relativePath,
            content: 'agent stale edit',
            mimeType: 'text/markdown',
            expectedFileId: agentRead.file_id,
            createOnly: false,
          }),
        ).rejects.toMatchObject({ code: 'SKILL_FILE_CONFLICT' });
        expect(saveBuffer).toHaveBeenCalledTimes(2);
        const agentPath = `/uploads/${saveBuffer.mock.calls[0][0].fileName}`;
        const browserPath = `/uploads/${saveBuffer.mock.calls[1][0].fileName}`;
        expect(await SkillFile.findOne({ skillId, relativePath }).lean()).toMatchObject({
          file_id: browserRevision,
          filepath: browserPath,
        });
        expect(deleteFile).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ filepath: agentPath }),
        );
        expect(deleteFile).not.toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({ filepath: browserPath }),
        );
      } finally {
        getStrategyFunctions.mockImplementation(originalStrategy);
      }
    });

    it('atomically rejects a race after storing bytes and cleans up only the losing upload', async () => {
      const { getStrategyFunctions } = require('~/server/services/Files/strategies');
      const originalStrategy = getStrategyFunctions.getMockImplementation();
      const { upsertSkillFile } = require('~/models');
      const created = await createSkillAsOwner();
      const skillId = created.body._id;
      const input = {
        skillId,
        relativePath: 'references/race.md',
        file_id: 'initial',
        filename: 'race.md',
        filepath: '/uploads/initial',
        source: 'local',
        mimeType: 'text/markdown',
        bytes: 4,
        author: testUsers.owner._id,
      };
      await upsertSkillFile(input);
      const deleteFile = jest.fn(async () => undefined);
      const saveBuffer = jest.fn(async ({ fileName }) => {
        // Another writer commits after the handler's preflight but before its atomic update.
        await upsertSkillFile({ ...input, file_id: 'winner', filepath: '/uploads/winner' });
        return `/uploads/${fileName}`;
      });
      getStrategyFunctions.mockReturnValue({ saveBuffer, deleteFile });
      try {
        const res = await request(app)
          .post(`/api/skills/${skillId}/files/references/race.md`)
          .field('relativePath', input.relativePath)
          .field('expectedFileId', 'initial')
          .attach('file', Buffer.from('losing draft'), {
            filename: 'race.md',
            contentType: 'text/markdown',
          });
        expect(res.status).toBe(409);
        expect(await SkillFile.findOne({ skillId }).lean()).toMatchObject({
          file_id: 'winner',
          filepath: '/uploads/winner',
        });
        expect(deleteFile).toHaveBeenCalledTimes(1);
        expect(deleteFile.mock.calls[0][1].filepath).toBe(
          `/uploads/${saveBuffer.mock.calls[0][0].fileName}`,
        );
      } finally {
        getStrategyFunctions.mockImplementation(originalStrategy);
      }
    });

    it('does not delete committed file bytes if the parent version bump fails', async () => {
      const created = await createSkillAsOwner();
      const { getStrategyFunctions } = require('~/server/services/Files/strategies');
      const originalStrategy = getStrategyFunctions.getMockImplementation();
      const deleteFile = jest.fn(async () => undefined);
      getStrategyFunctions.mockReturnValue({
        saveBuffer: jest.fn(async () => '/uploads/committed'),
        deleteFile,
      });
      const bump = jest
        .spyOn(Skill, 'findByIdAndUpdate')
        .mockRejectedValueOnce(new Error('parent update failed'));
      try {
        const response = await request(app)
          .post(`/api/skills/${created.body._id}/files`)
          .field('relativePath', 'references/committed.md')
          .attach('file', Buffer.from('committed text'), {
            filename: 'committed.md',
            contentType: 'text/markdown',
          });
        expect(response.status).toBe(500);
        expect(await SkillFile.findOne({ skillId: created.body._id }).lean()).toMatchObject({
          filepath: '/uploads/committed',
        });
        expect(deleteFile).not.toHaveBeenCalled();
      } finally {
        bump.mockRestore();
        getStrategyFunctions.mockImplementation(originalStrategy);
      }
    });

    it('cleans up the superseded blob when a replacement commits but the parent bump fails', async () => {
      const { getStrategyFunctions } = require('~/server/services/Files/strategies');
      const { upsertSkillFile } = require('~/models');
      const originalStrategy = getStrategyFunctions.getMockImplementation();
      const created = await createSkillAsOwner();
      const skillId = created.body._id;
      const oldPath = '/uploads/previous';
      const newPath = '/uploads/replacement';
      const stored = new Set([oldPath]);
      await upsertSkillFile({
        skillId,
        relativePath: 'references/committed.md',
        file_id: 'original',
        filename: 'committed.md',
        filepath: oldPath,
        source: 'local',
        mimeType: 'text/markdown',
        bytes: 8,
        author: testUsers.editor._id,
      });
      const deleteFile = jest.fn(async (_req, { filepath }) => {
        stored.delete(filepath);
      });
      const saveBuffer = jest.fn(async () => {
        stored.add(newPath);
        return newPath;
      });
      getStrategyFunctions.mockReturnValue({ saveBuffer, deleteFile });
      const bump = jest
        .spyOn(Skill, 'findByIdAndUpdate')
        .mockRejectedValueOnce(new Error('parent update failed'));
      try {
        const response = await request(app)
          .post(`/api/skills/${skillId}/files/references/committed.md`)
          .field('relativePath', 'references/committed.md')
          .field('expectedFileId', 'original')
          .attach('file', Buffer.from('new text'), {
            filename: 'committed.md',
            contentType: 'text/markdown',
          });
        expect(response.status).toBe(500);
        expect(await SkillFile.findOne({ skillId }).lean()).toMatchObject({
          filepath: newPath,
          file_id: expect.not.stringMatching('original'),
        });
        expect(saveBuffer).toHaveBeenCalledTimes(1);
        expect(deleteFile).toHaveBeenCalledTimes(1);
        expect(deleteFile.mock.calls[0][1]).toMatchObject({
          filepath: oldPath,
          user: testUsers.editor._id.toString(),
        });
        expect(stored.has(oldPath)).toBe(false);
        expect(stored.has(newPath)).toBe(true);
      } finally {
        bump.mockRestore();
        getStrategyFunctions.mockImplementation(originalStrategy);
      }
    });

    it('rejects a file save without EDIT access', async () => {
      const created = await createSkillAsOwner();
      setTestUser(testUsers.noAccess);
      const response = await request(app)
        .post(`/api/skills/${created.body._id}/files`)
        .field('relativePath', 'references/denied.md')
        .attach('file', Buffer.from('denied'), {
          filename: 'denied.md',
          contentType: 'text/markdown',
        });
      expect(response.status).toBe(403);
      expect(await SkillFile.countDocuments()).toBe(0);
    });

    it('requires both a revision and a matching body path on the conditional route', async () => {
      const created = await createSkillAsOwner();
      const url = `/api/skills/${created.body._id}/files/references/file.md`;
      const missing = await request(app)
        .post(url)
        .field('relativePath', 'references/file.md')
        .attach('file', Buffer.from('text'), { filename: 'file.md', contentType: 'text/markdown' });
      expect(missing.status).toBe(400);
      const mismatch = await request(app)
        .post(url)
        .field('relativePath', 'references/other.md')
        .field('expectedFileId', 'some-revision')
        .attach('file', Buffer.from('text'), { filename: 'file.md', contentType: 'text/markdown' });
      expect(mismatch.status).toBe(400);
      expect(await SkillFile.countDocuments()).toBe(0);
    });

    it('returns 400 when no file is provided', async () => {
      const created = await createSkillAsOwner();
      const res = await request(app).post(`/api/skills/${created.body._id}/files`);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/no file/i);
    });

    it('blocks text file content before storage', async () => {
      const created = await createSkillAsOwner();
      mockFilters = {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [
              { id: 'private_token', label: 'private token', regex: 'PRIVATE-\\d+' },
            ],
          },
        },
      };

      const res = await request(app)
        .post(`/api/skills/${created.body._id}/files`)
        .field('relativePath', 'references/notes.txt')
        .attach('file', Buffer.from('PRIVATE-1234'), {
          filename: 'notes.txt',
          contentType: 'text/plain',
        });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_block',
          source: 'file',
          field: 'extracted_text',
        }),
      );
      expect(await SkillFile.countDocuments()).toBe(0);
    });

    it('does not decode binary file bytes for filtering', async () => {
      const created = await createSkillAsOwner();
      mockFilters = {
        files: {
          pii: {
            fields: ['extracted_text'],
            starterPatterns: [],
            customPatterns: [
              { id: 'private_token', label: 'private token', regex: 'PRIVATE-\\d+' },
            ],
          },
        },
      };
      const binary = Buffer.concat([Buffer.from([0, 255, 0]), Buffer.from('PRIVATE-1234')]);

      const res = await request(app)
        .post(`/api/skills/${created.body._id}/files`)
        .field('relativePath', 'assets/private.png')
        .attach('file', binary, {
          filename: 'private.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(200);
      expect(await SkillFile.countDocuments()).toBe(1);
    });

    it('blocks an opaque skill file before storage when configured fail-closed', async () => {
      const created = await createSkillAsOwner();
      mockFilters = {
        files: {
          pii: {
            fields: ['content'],
            uninspectable: 'block',
          },
        },
      };
      const binary = Buffer.from([0, 255, 0, 137, 80, 78, 71]);

      const res = await request(app)
        .post(`/api/skills/${created.body._id}/files`)
        .field('relativePath', 'assets/private.png')
        .attach('file', binary, {
          filename: 'private.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: 'content_filter_uninspectable',
        message: 'Submitted file content could not be inspected before processing.',
        source: 'file',
        field: 'content',
      });
      expect(await SkillFile.countDocuments()).toBe(0);
    });

    it('blocks opaque uploads when the skill file_text policy is enabled', async () => {
      const created = await createSkillAsOwner();
      mockFilters = {
        skills: {
          pii: {
            fields: ['file_text'],
            starterPatterns: ['sk_prefix'],
          },
        },
        files: {
          pii: {
            fields: ['content'],
            uninspectable: 'allow',
          },
        },
      };
      const binary = Buffer.from([0, 255, 0, 137, 80, 78, 71]);

      const res = await request(app)
        .post(`/api/skills/${created.body._id}/files`)
        .field('relativePath', 'assets/private.png')
        .attach('file', binary, {
          filename: 'private.png',
          contentType: 'image/png',
        });

      expect(res.status).toBe(400);
      expect(res.body).toEqual(
        expect.objectContaining({
          error: 'content_filter_uninspectable',
          source: 'file',
          field: 'content',
        }),
      );
      expect(await SkillFile.countDocuments()).toBe(0);
    });
  });

  describe('GET /api/skills/:id/files/*relativePath', () => {
    const { upsertSkillFile, updateSkillFileContent } = require('~/models');

    async function seedNestedFile(skillId, relativePath, content) {
      await upsertSkillFile({
        skillId,
        relativePath,
        file_id: `file-${relativePath}`,
        filename: relativePath.split('/').pop(),
        filepath: `/tmp/${relativePath}`,
        source: 'local',
        mimeType: 'text/markdown',
        bytes: content.length,
        author: testUsers.owner._id,
      });
      // Seed cached content so the handler returns it without streaming
      await updateSkillFileContent(skillId, relativePath, { content, isBinary: false });
    }

    it('returns SKILL.md content from skill body', async () => {
      const created = await createSkillAsOwner();
      const res = await request(app).get(`/api/skills/${created.body._id}/files/SKILL.md`);
      expect(res.status).toBe(200);
      expect(res.body.mimeType).toBe('text/markdown');
      expect(res.body.isBinary).toBe(false);
      expect(res.body.filename).toBe('SKILL.md');
      expect(res.body.content).toBeDefined();
    });

    it('returns a nested file when the path is percent-encoded (%2F)', async () => {
      const created = await createSkillAsOwner();
      await seedNestedFile(created.body._id, 'references/working-patterns.md', 'nested body');
      const res = await request(app).get(
        `/api/skills/${created.body._id}/files/references%2Fworking-patterns.md`,
      );
      expect(res.status).toBe(200);
      expect(res.body.relativePath).toBe('references/working-patterns.md');
      expect(res.body.content).toBe('nested body');
    });

    it('returns a nested file when a proxy decoded %2F to a literal slash', async () => {
      const created = await createSkillAsOwner();
      await seedNestedFile(created.body._id, 'references/working-patterns.md', 'nested body');
      const res = await request(app).get(
        `/api/skills/${created.body._id}/files/references/working-patterns.md`,
      );
      expect(res.status).toBe(200);
      expect(res.body.relativePath).toBe('references/working-patterns.md');
      expect(res.body.content).toBe('nested body');
    });

    it('returns a deeply nested file (multiple subfolders)', async () => {
      const created = await createSkillAsOwner();
      await seedNestedFile(created.body._id, 'assets/img/icons/logo.md', 'deep');
      const res = await request(app).get(
        `/api/skills/${created.body._id}/files/assets/img/icons/logo.md`,
      );
      expect(res.status).toBe(200);
      expect(res.body.relativePath).toBe('assets/img/icons/logo.md');
      expect(res.body.content).toBe('deep');
    });

    it('returns 404 for a nonexistent file', async () => {
      const created = await createSkillAsOwner();
      const res = await request(app).get(
        `/api/skills/${created.body._id}/files/scripts%2Fmissing.sh`,
      );
      expect(res.status).toBe(404);
    });

    it('returns 404 for a path traversal attempt', async () => {
      const created = await createSkillAsOwner();
      const res = await request(app).get(
        `/api/skills/${created.body._id}/files/references%2F..%2F..%2Fetc%2Fpasswd`,
      );
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/skills/:id/files/*relativePath', () => {
    const { upsertSkillFile } = require('~/models');

    it('deletes an existing skill file, bumps skill version, and returns 200', async () => {
      const created = await createSkillAsOwner();
      await upsertSkillFile({
        skillId: created.body._id,
        relativePath: 'scripts/parse.sh',
        file_id: 'file-1',
        filename: 'parse.sh',
        filepath: '/tmp/parse.sh',
        source: 'local',
        mimeType: 'text/x-shellscript',
        bytes: 42,
        author: testUsers.owner._id,
      });

      const beforeSkill = await request(app).get(`/api/skills/${created.body._id}`);
      expect(beforeSkill.body.fileCount).toBe(1);
      expect(beforeSkill.body.version).toBe(2);

      const res = await request(app).delete(
        `/api/skills/${created.body._id}/files/scripts%2Fparse.sh`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        skillId: created.body._id,
        relativePath: 'scripts/parse.sh',
        deleted: true,
      });

      const afterSkill = await request(app).get(`/api/skills/${created.body._id}`);
      expect(afterSkill.body.fileCount).toBe(0);
      expect(afterSkill.body.version).toBe(3);
    });

    it('deletes a nested file when a proxy decoded %2F to a literal slash', async () => {
      const created = await createSkillAsOwner();
      await upsertSkillFile({
        skillId: created.body._id,
        relativePath: 'references/notes.md',
        file_id: 'file-2',
        filename: 'notes.md',
        filepath: '/tmp/notes.md',
        source: 'local',
        mimeType: 'text/markdown',
        bytes: 12,
        author: testUsers.owner._id,
      });

      const res = await request(app).delete(
        `/api/skills/${created.body._id}/files/references/notes.md`,
      );
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        skillId: created.body._id,
        relativePath: 'references/notes.md',
        deleted: true,
      });

      const afterSkill = await request(app).get(`/api/skills/${created.body._id}`);
      expect(afterSkill.body.fileCount).toBe(0);
    });

    it('returns 404 when the file does not exist', async () => {
      const created = await createSkillAsOwner();
      const res = await request(app).delete(
        `/api/skills/${created.body._id}/files/scripts%2Fmissing.sh`,
      );
      expect(res.status).toBe(404);
    });

    it('returns 403 for a non-owner', async () => {
      const created = await createSkillAsOwner();
      setTestUser(testUsers.noAccess);
      const res = await request(app).delete(
        `/api/skills/${created.body._id}/files/scripts%2Fparse.sh`,
      );
      expect(res.status).toBe(403);
    });
  });

  describe('Sharing via ACL (editor grant)', () => {
    it('allows an editor to patch a shared skill', async () => {
      const created = await createSkillAsOwner();
      await grantPermission({
        principalType: PrincipalType.USER,
        principalId: testUsers.editor._id,
        resourceType: ResourceType.SKILL,
        resourceId: created.body._id,
        accessRoleId: AccessRoleIds.SKILL_EDITOR,
        grantedBy: testUsers.owner._id,
      });

      setTestUser(testUsers.editor);
      const res = await request(app)
        .patch(`/api/skills/${created.body._id}`)
        .send({ expectedVersion: 1, description: 'Edited by editor' });
      expect(res.status).toBe(200);

      // Editor should NOT be able to delete
      const del = await request(app).delete(`/api/skills/${created.body._id}`);
      expect(del.status).toBe(403);
    });
  });
});
