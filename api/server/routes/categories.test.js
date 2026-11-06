const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  SystemRoles,
  ResourceType,
  AccessRoleIds,
  PrincipalType,
  PermissionBits,
  PermissionTypes,
  Permissions,
} = require('librechat-data-provider');
let mockBaseConfig = {};

const mockHrOverride = {
  principalType: 'role',
  principalId: 'HR',
  priority: 10,
  overrides: {
    prompts: {
      categories: {
        enableDefaultCategories: false,
        list: [{ value: 'benefits', label: 'Benefits' }],
      },
    },
  },
};

jest.mock('~/server/services/Config', () => ({
  getAppConfig: jest.fn(async ({ role } = {}) => {
    const { mergeConfigOverrides } = require('@librechat/data-schemas');
    return role === 'HR' ? mergeConfigOverrides(mockBaseConfig, [mockHrOverride]) : mockBaseConfig;
  }),
}));

jest.mock('~/models', () => {
  const mongoose = require('mongoose');
  const { createMethods } = require('@librechat/data-schemas');
  const methods = createMethods(mongoose, {
    removeAllPermissions: async ({ resourceType, resourceId }) => {
      await mongoose.models.AclEntry?.deleteMany({ resourceType, resourceId });
    },
  });
  return {
    ...methods,
    getPromptGroupAccessContext: jest.fn(methods.getPromptGroupAccessContext),
    getDistinctPromptGroupCategories: jest.fn(methods.getDistinctPromptGroupCategories),
  };
});

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (req, res, next) => next(),
  configMiddleware: jest.requireActual('~/server/middleware/config/app'),
}));

const builtins = [
  { label: 'com_ui_idea', value: 'idea' },
  { label: 'com_ui_travel', value: 'travel' },
  { label: 'com_ui_teach_or_explain', value: 'teach_or_explain' },
  { label: 'com_ui_write', value: 'write' },
  { label: 'com_ui_shop', value: 'shop' },
  { label: 'com_ui_code', value: 'code' },
  { label: 'com_ui_misc', value: 'misc' },
  { label: 'com_ui_roleplay', value: 'roleplay' },
  { label: 'com_ui_finance', value: 'finance' },
];

let app;
let mongoServer;
let models;
let users;
let currentUser;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());

  const { AccessRole, User, Role } = require('~/db/models');
  await Role.create({
    name: 'NO_PROMPTS',
    permissions: { [PermissionTypes.PROMPTS]: { [Permissions.USE]: false } },
  });
  await AccessRole.create({
    accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
    name: 'Owner',
    resourceType: ResourceType.PROMPTGROUP,
    permBits:
      PermissionBits.VIEW | PermissionBits.EDIT | PermissionBits.DELETE | PermissionBits.SHARE,
  });
  users = {
    a: await User.create({ name: 'A', email: 'a@example.com', role: SystemRoles.USER }),
    b: await User.create({ name: 'B', email: 'b@example.com', role: SystemRoles.USER }),
    hr: await User.create({ name: 'HR', email: 'hr@example.com', role: 'HR' }),
    noPrompts: await User.create({ name: 'NP', email: 'np@example.com', role: 'NO_PROMPTS' }),
  };
  models = require('~/models');

  app = express();
  app.use((req, res, next) => {
    req.user = {
      id: currentUser._id.toString(),
      _id: currentUser._id,
      role: currentUser.role,
    };
    next();
  });
  app.use('/api/categories', require('./categories'));
});

beforeEach(() => {
  currentUser = users.a;
  mockBaseConfig = {};
  jest.clearAllMocks();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

describe('GET /api/categories', () => {
  it('defaults unchanged when no prompts config is set', async () => {
    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(200);
    expect(res.body).toEqual(builtins);
  });

  it('applies the role override per requesting role', async () => {
    currentUser = users.hr;
    const hr = await request(app).get('/api/categories');
    expect(hr.status).toBe(200);
    expect(hr.body).toEqual([{ value: 'benefits', label: 'Benefits' }]);

    currentUser = users.a;
    const user = await request(app).get('/api/categories');
    expect(user.body).toEqual(builtins);
  });

  it('gives no error leak when the custom category read fails', async () => {
    mockBaseConfig = { prompts: { categories: { allowCustom: true } } };
    models.getDistinctPromptGroupCategories.mockRejectedValueOnce(new Error('secret db detail'));

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ message: 'Failed to retrieve categories' });
    expect(res.text).not.toContain('secret');
  });

  it('keeps custom categories access scoped to the requesting user', async () => {
    mockBaseConfig = { prompts: { categories: { allowCustom: true } } };
    const { grantPermission } = require('~/server/services/PermissionService');
    const { group } = await models.createPromptGroup({
      prompt: { prompt: 'secret text', type: 'text' },
      group: { name: 'private group', category: 'A-Private' },
      author: users.a._id.toString(),
      authorName: users.a.name,
    });
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: users.a._id,
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: group._id,
      accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
      grantedBy: users.a._id,
    });

    currentUser = users.b;
    const forB = await request(app).get('/api/categories');
    expect(forB.body.map((c) => c.value)).not.toContain('A-Private');

    currentUser = users.a;
    const forA = await request(app).get('/api/categories');
    expect(forA.body).toContainEqual({ value: 'A-Private', label: 'A-Private', custom: true });
  });

  it('serves configured categories only to a user without prompt-use permission', async () => {
    mockBaseConfig = {
      prompts: {
        categories: { allowCustom: true, enableDefaultCategories: false, list: [{ value: 'hr' }] },
      },
    };
    const { grantPermission } = require('~/server/services/PermissionService');
    const { group } = await models.createPromptGroup({
      prompt: { prompt: 'text', type: 'text' },
      group: { name: 'shared group', category: 'Stored' },
      author: users.noPrompts._id.toString(),
      authorName: users.noPrompts.name,
    });
    await grantPermission({
      principalType: PrincipalType.USER,
      principalId: users.noPrompts._id,
      resourceType: ResourceType.PROMPTGROUP,
      resourceId: group._id,
      accessRoleId: AccessRoleIds.PROMPTGROUP_OWNER,
      grantedBy: users.noPrompts._id,
    });

    currentUser = users.noPrompts;
    const denied = await request(app).get('/api/categories');
    expect(denied.status).toBe(200);
    expect(denied.body).toEqual([{ value: 'hr', label: 'hr' }]);
    expect(models.getDistinctPromptGroupCategories).not.toHaveBeenCalled();
  });

  it('no reads when off: custom categories disabled', async () => {
    mockBaseConfig = { prompts: { categories: { allowCustom: false } } };

    const res = await request(app).get('/api/categories');

    expect(res.status).toBe(200);
    expect(models.getPromptGroupAccessContext).not.toHaveBeenCalled();
    expect(models.getDistinctPromptGroupCategories).not.toHaveBeenCalled();
  });
});
