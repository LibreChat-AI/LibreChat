const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { ResourceType, PrincipalType, PrincipalModel } = require('librechat-data-provider');
const { canAccessArtifactAppResource } = require('./canAccessArtifactAppResource');
const { User, Role, AclEntry } = require('~/db/models');
const { createArtifactAppWithVersion } = require('~/models');

const VIEW = 1;
const EDIT = 2;
const DELETE = 4;

/** Owner ACL bits (view+edit+delete+share), matching what publish grants. */
const OWNER_BITS = 15;

describe('canAccessArtifactAppResource middleware', () => {
  let mongoServer;
  let req, res, next;
  let testUser;

  const publishApp = async (createdBy) =>
    createArtifactAppWithVersion({
      title: 'Test App',
      visibility: 'private',
      createdBy: String(createdBy),
      version: {
        artifactType: 'react',
        sourceSnapshot: 'export default () => <div>hi</div>;',
        createdBy: String(createdBy),
      },
    });

  const grant = async ({ principalId, resourceId, permBits, grantedBy }) =>
    AclEntry.create({
      principalType: PrincipalType.USER,
      principalId,
      principalModel: PrincipalModel.USER,
      resourceType: ResourceType.ARTIFACT_APP,
      resourceId,
      permBits,
      grantedBy: grantedBy ?? principalId,
    });

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await mongoose.connection.dropDatabase();
    await Role.create({ name: 'test-role', permissions: {} });
    testUser = await User.create({
      email: 'test@example.com',
      name: 'Test User',
      username: 'testuser',
      role: 'test-role',
    });

    req = { user: { id: testUser._id, role: testUser.role }, params: {} };
    res = { status: jest.fn().mockReturnThis(), json: jest.fn() };
    next = jest.fn();
    jest.clearAllMocks();
  });

  describe('middleware factory', () => {
    test('throws when requiredPermission is missing', () => {
      expect(() => canAccessArtifactAppResource({})).toThrow(
        'canAccessArtifactAppResource: requiredPermission is required and must be a number',
      );
    });

    test('throws when requiredPermission is not a number', () => {
      expect(() => canAccessArtifactAppResource({ requiredPermission: '1' })).toThrow(
        'canAccessArtifactAppResource: requiredPermission is required and must be a number',
      );
    });

    test('throws when called with no options at all', () => {
      expect(() => canAccessArtifactAppResource()).toThrow(
        'canAccessArtifactAppResource: requiredPermission is required and must be a number',
      );
    });

    test('returns an express middleware with the default resourceIdParam', () => {
      const middleware = canAccessArtifactAppResource({ requiredPermission: VIEW });
      expect(typeof middleware).toBe('function');
      expect(middleware.length).toBe(3);
    });
  });

  describe('permission checking against real ACL entries', () => {
    test('allows the owner to view their own app', async () => {
      const { app } = await publishApp(testUser._id);
      await grant({ principalId: testUser._id, resourceId: app.id, permBits: OWNER_BITS });
      req.params.id = app.artifactAppId;

      await canAccessArtifactAppResource({ requiredPermission: VIEW })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('denies a user with no ACL entry for the app', async () => {
      const otherUser = await User.create({
        email: 'other@example.com',
        name: 'Other User',
        username: 'otheruser',
        role: 'test-role',
      });
      const { app } = await publishApp(otherUser._id);
      await grant({ principalId: otherUser._id, resourceId: app.id, permBits: OWNER_BITS });
      req.params.id = app.artifactAppId;

      await canAccessArtifactAppResource({ requiredPermission: VIEW })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Forbidden',
        message: `Insufficient permissions to access this ${ResourceType.ARTIFACT_APP}`,
      });
    });

    /* The route table gates PATCH on EDIT and DELETE on DELETE, so a
     * view-only grant must not satisfy either. */
    test.each([
      ['edit', EDIT],
      ['delete', DELETE],
    ])('denies %s when the grant is view-only', async (_label, requiredPermission) => {
      const { app } = await publishApp(testUser._id);
      await grant({ principalId: testUser._id, resourceId: app.id, permBits: VIEW });
      req.params.id = app.artifactAppId;

      await canAccessArtifactAppResource({ requiredPermission })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('allows edit when the grant carries edit bits', async () => {
      const { app } = await publishApp(testUser._id);
      await grant({ principalId: testUser._id, resourceId: app.id, permBits: VIEW | EDIT });
      req.params.id = app.artifactAppId;

      await canAccessArtifactAppResource({ requiredPermission: EDIT })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });

    test('returns 404 for an unknown artifact app id', async () => {
      req.params.id = 'app_does_not_exist';

      await canAccessArtifactAppResource({ requiredPermission: VIEW })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(404);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Not Found',
        message: `${ResourceType.ARTIFACT_APP} not found`,
      });
    });

    /* A grant on the same ObjectId under a different resourceType must not
     * leak across: ACL rows are keyed by (resourceType, resourceId). */
    test('ignores a grant recorded under a different resourceType', async () => {
      const { app } = await publishApp(testUser._id);
      await AclEntry.create({
        principalType: PrincipalType.USER,
        principalId: testUser._id,
        principalModel: PrincipalModel.USER,
        resourceType: ResourceType.AGENT,
        resourceId: app.id,
        permBits: OWNER_BITS,
        grantedBy: testUser._id,
      });
      req.params.id = app.artifactAppId;

      await canAccessArtifactAppResource({ requiredPermission: VIEW })(req, res, next);

      expect(next).not.toHaveBeenCalled();
      expect(res.status).toHaveBeenCalledWith(403);
    });

    test('reads the app id from a custom resourceIdParam', async () => {
      const { app } = await publishApp(testUser._id);
      await grant({ principalId: testUser._id, resourceId: app.id, permBits: OWNER_BITS });
      req.params.appId = app.artifactAppId;

      await canAccessArtifactAppResource({
        requiredPermission: VIEW,
        resourceIdParam: 'appId',
      })(req, res, next);

      expect(next).toHaveBeenCalled();
      expect(res.status).not.toHaveBeenCalled();
    });
  });
});
