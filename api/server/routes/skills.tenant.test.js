process.env.TENANT_ISOLATION_STRICT = 'true';

const express = require('express');
const request = require('supertest');
const JSZip = require('jszip');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { tenantStorage } = require('@librechat/data-schemas');
const {
  SystemRoles,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
} = require('librechat-data-provider');

const TEST_TENANT = 'tenant-skills-strict';

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
  return {
    ...methods,
    getRoleByName: jest.fn(),
  };
});

jest.mock('~/server/middleware', () => {
  const actual = jest.requireActual('~/server/middleware');
  const { tenantStorage } = require('@librechat/data-schemas');

  return {
    requireJwtAuth: (req, _res, next) => {
      const tenantId = req.tenantId ?? req.user?.tenantId;
      if (!tenantId) {
        next();
        return;
      }
      tenantStorage.run({ tenantId }, async () => next());
    },
    canAccessSkillResource: actual.canAccessSkillResource,
  };
});

let app;
let mongoServer;
let Skill;
let SkillFile;
let AclEntry;
let AccessRole;
let User;
let testUsers;
let testRoles;
let currentTestUser;
let currentRequestTenantId;

function setTestUser(user) {
  currentTestUser = user;
}

function toRequestUser(user) {
  const raw = user.toObject ? user.toObject() : user;
  return {
    ...raw,
    id: user._id.toString(),
    _id: user._id,
    name: user.name,
    role: user.role,
    tenantId: user.tenantId,
  };
}

async function runInTenant(fn) {
  return tenantStorage.run({ tenantId: TEST_TENANT }, fn);
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

  await runInTenant(setupTestData);

  app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    if (currentRequestTenantId) {
      req.tenantId = currentRequestTenantId;
    }
    if (currentTestUser) {
      req.user = toRequestUser(currentTestUser);
    }
    next();
  });

  currentTestUser = testUsers.owner;
  app.use('/api/skills', require('./skills'));
});

afterEach(async () => {
  await runInTenant(async () => {
    await Skill.deleteMany({});
    await SkillFile.deleteMany({});
    await AclEntry.deleteMany({});
  });
  currentTestUser = testUsers.owner;
  currentRequestTenantId = undefined;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
  delete process.env.TENANT_ISOLATION_STRICT;
  jest.clearAllMocks();
});

async function setupTestData() {
  testRoles = {
    owner: await AccessRole.create({
      accessRoleId: AccessRoleIds.SKILL_OWNER,
      name: 'Owner',
      resourceType: ResourceType.SKILL,
      permBits:
        PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE,
      tenantId: TEST_TENANT,
    }),
  };

  testUsers = {
    owner: await User.create({
      name: 'Strict Skill Owner',
      email: 'strict-skill-owner@test.com',
      role: SystemRoles.USER,
      tenantId: TEST_TENANT,
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
  return request(app)
    .post('/api/skills')
    .send({
      name: 'strict-file-skill',
      description: 'A strict tenant skill used in multipart route tests.',
      body: '# Strict File Skill',
      ...overrides,
    });
}

describe('Skill multipart routes under strict tenant isolation', () => {
  it('imports a skill zip and writes skill, ACL, and files in the request tenant', async () => {
    const zip = new JSZip();
    zip.file(
      'SKILL.md',
      [
        '---',
        'name: strict-import',
        'description: Strict tenant import route test skill.',
        '---',
        '# Strict Import',
      ].join('\n'),
    );
    zip.file('scripts/run.sh', 'echo strict');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });

    const res = await request(app).post('/api/skills/import').attach('file', buffer, {
      filename: 'strict-import.skill',
      contentType: 'application/zip',
    });

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(TEST_TENANT);
    expect(res.body._importSummary.filesSucceeded).toBe(1);

    const { skill, acl, file } = await runInTenant(async () => {
      const skill = await Skill.findOne({ name: 'strict-import' }).lean();
      const acl = await AclEntry.findOne({
        resourceType: ResourceType.SKILL,
        resourceId: skill._id,
        principalType: PrincipalType.USER,
        principalId: testUsers.owner._id,
      }).lean();
      const file = await SkillFile.findOne({
        skillId: skill._id,
        relativePath: 'scripts/run.sh',
      }).lean();
      return { skill, acl, file };
    });

    expect(skill.tenantId).toBe(TEST_TENANT);
    expect(acl).toEqual(
      expect.objectContaining({
        tenantId: TEST_TENANT,
        roleId: testRoles.owner._id,
      }),
    );
    expect(file).toEqual(
      expect.objectContaining({
        tenantId: TEST_TENANT,
        relativePath: 'scripts/run.sh',
      }),
    );
  });

  it('imports using the resolved request tenant when user tenant differs', async () => {
    currentRequestTenantId = TEST_TENANT;
    setTestUser({
      ...testUsers.owner.toObject(),
      tenantId: 'stale-user-tenant',
    });

    const res = await request(app)
      .post('/api/skills/import')
      .attach('file', Buffer.from('# Request Tenant Markdown'), {
        filename: 'request-tenant.md',
        contentType: 'text/markdown',
      });

    expect(res.status).toBe(201);
    expect(res.body.tenantId).toBe(TEST_TENANT);

    const savedSkill = await runInTenant(async () =>
      Skill.findOne({ name: 'request-tenant' }).lean(),
    );
    expect(savedSkill).toEqual(
      expect.objectContaining({
        tenantId: TEST_TENANT,
      }),
    );
  });

  it('rejects multipart import in strict mode when the request has no tenant', async () => {
    setTestUser({
      _id: new mongoose.Types.ObjectId(),
      name: 'No Tenant',
      role: SystemRoles.USER,
    });

    const res = await request(app)
      .post('/api/skills/import')
      .attach('file', Buffer.from('# No Tenant'), {
        filename: 'no-tenant.md',
        contentType: 'text/markdown',
      });

    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/Tenant context required/);
  });

  it('uploads an individual skill file in the request tenant', async () => {
    const created = await createSkillAsOwner();
    expect(created.status).toBe(201);

    const res = await request(app)
      .post(`/api/skills/${created.body._id}/files`)
      .field('relativePath', 'scripts/manual.sh')
      .attach('file', Buffer.from('echo manual'), {
        filename: 'manual.sh',
        contentType: 'text/x-shellscript',
      });

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(TEST_TENANT);

    const savedFile = await runInTenant(async () =>
      SkillFile.findOne({
        skillId: created.body._id,
        relativePath: 'scripts/manual.sh',
      }).lean(),
    );
    expect(savedFile).toEqual(
      expect.objectContaining({
        tenantId: TEST_TENANT,
        relativePath: 'scripts/manual.sh',
      }),
    );
  });

  it('uploads an individual skill file using the resolved request tenant', async () => {
    const created = await createSkillAsOwner({ name: 'request-tenant-file-skill' });
    expect(created.status).toBe(201);

    currentRequestTenantId = TEST_TENANT;
    setTestUser({
      ...testUsers.owner.toObject(),
      tenantId: 'stale-user-tenant',
    });

    const res = await request(app)
      .post(`/api/skills/${created.body._id}/files`)
      .field('relativePath', 'scripts/request-tenant.sh')
      .attach('file', Buffer.from('echo request tenant'), {
        filename: 'request-tenant.sh',
        contentType: 'text/x-shellscript',
      });

    expect(res.status).toBe(200);
    expect(res.body.tenantId).toBe(TEST_TENANT);

    const savedFile = await runInTenant(async () =>
      SkillFile.findOne({
        skillId: created.body._id,
        relativePath: 'scripts/request-tenant.sh',
      }).lean(),
    );
    expect(savedFile).toEqual(
      expect.objectContaining({
        tenantId: TEST_TENANT,
        relativePath: 'scripts/request-tenant.sh',
      }),
    );
  });
});
