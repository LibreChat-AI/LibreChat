const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { checkAccess, generateCheckAccess } = require('@librechat/api');
const { PermissionTypes, Permissions } = require('librechat-data-provider');
const { getRoleByName } = require('~/models');
const { Role } = require('~/db/models');

// Mock the logger from @librechat/data-schemas
jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: {
    warn: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock the cache to use a simple in-memory implementation
const mockCache = new Map();
jest.mock('~/cache/getLogStores', () => {
  return jest.fn(() => ({
    get: jest.fn(async (key) => mockCache.get(key)),
    set: jest.fn(async (key, value) => mockCache.set(key, value)),
    clear: jest.fn(async () => mockCache.clear()),
  }));
});

describe('Access Middleware', () => {
  let mongoServer;
  let req, res, next;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    const mongoUri = mongoServer.getUri();
    await mongoose.connect(mongoUri);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer?.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    mockCache.clear(); // Clear the cache between tests

    // Create test roles
    await Role.create({
      name: 'user',
      permissions: {
        [PermissionTypes.BOOKMARKS]: { [Permissions.USE]: true },
        [PermissionTypes.PROMPTS]: {
          [Permissions.USE]: true,
          [Permissions.CREATE]: true,
          [Permissions.SHARE]: true,
        },
        [PermissionTypes.MEMORIES]: {
          [Permissions.USE]: true,
          [Permissions.CREATE]: true,
          [Permissions.UPDATE]: true,
          [Permissions.READ]: true,
          [Permissions.OPT_OUT]: true,
        },
        [PermissionTypes.AGENTS]: {
          [Permissions.USE]: true,
          [Permissions.CREATE]: false,
          [Permissions.SHARE]: false,
        },
        [PermissionTypes.MULTI_CONVO]: { [Permissions.USE]: true },
        [PermissionTypes.TEMPORARY_CHAT]: { [Permissions.USE]: true },
        [PermissionTypes.RUN_CODE]: { [Permissions.USE]: true },
        [PermissionTypes.WEB_SEARCH]: { [Permissions.USE]: true },
      },
    });

    await Role.create({
      name: 'admin',
      permissions: {
        [PermissionTypes.BOOKMARKS]: { [Permissions.USE]: true },
        [PermissionTypes.PROMPTS]: {
          [Permissions.USE]: true,
          [Permissions.CREATE]: true,
          [Permissions.SHARE]: true,
        },
        [PermissionTypes.MEMORIES]: {
          [Permissions.USE]: true,
          [Permissions.CREATE]: true,
          [Permissions.UPDATE]: true,
          [Permissions.READ]: true,
          [Permissions.OPT_OUT]: true,
        },
        [PermissionTypes.AGENTS]: {
          [Permissions.USE]: true,
          [Permissions.CREATE]: true,
          [Permissions.SHARE]: true,
        },
        [PermissionTypes.MULTI_CONVO]: { [Permissions.USE]: true },
        [PermissionTypes.TEMPORARY_CHAT]: { [Permissions.USE]: true },
        [PermissionTypes.RUN_CODE]: { [Permissions.USE]: true },
        [PermissionTypes.WEB_SEARCH]: { [Permissions.USE]: true },
      },
    });

    // Create limited role with no AGENTS permissions
    await Role.create({
      name: 'limited',
      permissions: {
        // Explicitly set AGENTS permissions to false
        [PermissionTypes.AGENTS]: {
          [Permissions.USE]: false,
          [Permissions.CREATE]: false,
          [Permissions.SHARE]: false,
        },
        // Has permissions for other types
        [PermissionTypes.PROMPTS]: {
          [Permissions.USE]: true,
        },
      },
    });

    req = {
      user: { id: 'user123', role: 'user' },
      body: {},
      originalUrl: '/test',
    };
    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };
    next = jest.fn();
    jest.clearAllMocks();
  });

  describe('checkAccess', () => {
    test('should return false if user is not provided', async () => {
      const result = await checkAccess({
        user: null,
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName,
      });
      expect(result).toBe(false);
    });

    test('should return true if user has required permission', async () => {
      const result = await checkAccess({
        req: {},
        user: { id: 'user123', role: 'user' },
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName,
      });
      expect(result).toBe(true);
    });

    test('should return false if user lacks required permission', async () => {
      const result = await checkAccess({
        req: {},
        user: { id: 'user123', role: 'user' },
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.CREATE],
        getRoleByName,
      });
      expect(result).toBe(false);
    });

    test('should return false if user has only some of multiple permissions', async () => {
      // User has USE but not CREATE, so should fail when checking for both
      const result = await checkAccess({
        req: {},
        user: { id: 'user123', role: 'user' },
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.CREATE, Permissions.USE],
        getRoleByName,
      });
      expect(result).toBe(false);
    });

    test('should return true if user has all of multiple permissions', async () => {
      // Admin has both USE and CREATE
      const result = await checkAccess({
        req: {},
        user: { id: 'admin123', role: 'admin' },
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.CREATE, Permissions.USE],
        getRoleByName,
      });
      expect(result).toBe(true);
    });

    test('should check body properties when permission is not directly granted', async () => {
      const req = { body: { id: 'agent123' } };
      const result = await checkAccess({
        req,
        user: { id: 'user123', role: 'user' },
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.UPDATE],
        bodyProps: {
          [Permissions.UPDATE]: ['id'],
        },
        checkObject: req.body,
        getRoleByName,
      });
      expect(result).toBe(true);
    });

    test('should return false if role is not found', async () => {
      const result = await checkAccess({
        req: {},
        user: { id: 'user123', role: 'nonexistent' },
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName,
      });
      expect(result).toBe(false);
    });

    test('should return false if role has no permissions for the requested type', async () => {
      const result = await checkAccess({
        req: {},
        user: { id: 'user123', role: 'limited' },
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName,
      });
      expect(result).toBe(false);
    });

    test('should handle admin role with all permissions', async () => {
      const createResult = await checkAccess({
        req: {},
        user: { id: 'admin123', role: 'admin' },
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.CREATE],
        getRoleByName,
      });
      expect(createResult).toBe(true);

      const shareResult = await checkAccess({
        req: {},
        user: { id: 'admin123', role: 'admin' },
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.SHARE],
        getRoleByName,
      });
      expect(shareResult).toBe(true);
    });
  });

  describe('generateCheckAccess', () => {
    test('should call next() when user has required permission', async () => {
      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName,
      });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should return 403 when user lacks permission', async () => {
      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.CREATE],
        getRoleByName,
      });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ message: 'Forbidden: Insufficient permissions' });
    });

    test('should check body properties when configured', async () => {
      req.body = { agentId: 'agent123', description: 'test' };

      const bodyProps = {
        [Permissions.CREATE]: ['agentId'],
      };

      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.CREATE],
        bodyProps,
        getRoleByName,
      });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('should handle database errors gracefully', async () => {
      // Mock getRoleByName to throw an error
      const mockGetRoleByName = jest
        .fn()
        .mockRejectedValue(new Error('Database connection failed'));

      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName: mockGetRoleByName,
      });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        message: expect.stringContaining('Server error:'),
      });
    });

    test('should work with multiple permission types', async () => {
      req.user.role = 'admin';

      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE, Permissions.CREATE, Permissions.SHARE],
        getRoleByName,
      });
      await middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    test('should handle missing user gracefully', async () => {
      req.user = null;

      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName,
      });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ message: 'Forbidden: Insufficient permissions' });
    });

    test('should handle role with no AGENTS permissions', async () => {
      await Role.create({
        name: 'noaccess',
        permissions: {
          // Explicitly set AGENTS with all permissions false
          [PermissionTypes.AGENTS]: {
            [Permissions.USE]: false,
            [Permissions.CREATE]: false,
            [Permissions.SHARE]: false,
          },
        },
      });
      req.user.role = 'noaccess';

      const middleware = generateCheckAccess({
        permissionType: PermissionTypes.AGENTS,
        permissions: [Permissions.USE],
        getRoleByName,
      });
      await middleware(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({ message: 'Forbidden: Insufficient permissions' });
    });
  });
});
