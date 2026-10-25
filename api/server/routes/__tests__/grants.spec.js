const express = require('express');
const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, createMethods } = require('@librechat/data-schemas');
const { PrincipalType, SystemRoles } = require('librechat-data-provider');

/**
 * Integration test for the admin grants routes.
 *
 * Validates the full Express wiring: route registration → middleware →
 * handler → real MongoDB. Auth middleware is injected (matching the repo
 * pattern in keys.spec.js) so we can control the caller identity without
 * a real JWT, while the handler DI deps use real DB methods.
 */

jest.mock('~/server/middleware', () => ({
  requireJwtAuth: (_req, _res, next) => next(),
}));

jest.mock('~/server/middleware/roles/capabilities', () => ({
  requireCapability: () => (_req, _res, next) => next(),
}));

let mongoServer;
let db;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  db = createMethods(mongoose);
  await db.seedSystemGrants();
  await db.initializeRoles();
  await db.seedDefaultRoles();
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

afterEach(async () => {
  const SystemGrant = mongoose.models.SystemGrant;
  // Clean non-seed grants (keep admin seed)
  await SystemGrant.deleteMany({
    $or: [
      { principalId: { $ne: SystemRoles.ADMIN } },
      { principalType: { $ne: PrincipalType.ROLE } },
    ],
  });
});

function createApp(user) {
  const { createAdminGrantsHandlers, getCachedPrincipals } = require('@librechat/api');

  const handlers = createAdminGrantsHandlers({
    listGrants: db.listGrants,
    countGrants: db.countGrants,
    getCapabilitiesForPrincipal: db.getCapabilitiesForPrincipal,
    getCapabilitiesForPrincipals: db.getCapabilitiesForPrincipals,
    grantCapability: db.grantCapability,
    revokeCapability: db.revokeCapability,
    getUserPrincipals: db.getUserPrincipals,
    hasCapabilityForPrincipals: db.hasCapabilityForPrincipals,
    getHeldCapabilities: db.getHeldCapabilities,
    getCachedPrincipals,
    checkRoleExists: async (name) => (await db.getPartitionRole(name)) != null,
  });

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = user;
    next();
  });

  const router = express.Router();
  router.get('/', handlers.listGrants);
  router.get('/effective', handlers.getEffectiveCapabilities);
  router.get('/:principalType/:principalId', handlers.getPrincipalGrants);
  router.post('/', handlers.assignGrant);
  router.delete('/:principalType/:principalId/:capability', handlers.revokeGrant);
  app.use('/api/admin/grants', router);

  return app;
}

describe('Admin Grants Routes — Integration', () => {
  const adminUserId = new mongoose.Types.ObjectId();
  const adminUser = {
    _id: adminUserId,
    id: adminUserId.toString(),
    role: SystemRoles.ADMIN,
  };

  it('GET / returns seeded admin grants', async () => {
    const app = createApp(adminUser);
    const res = await request(app).get('/api/admin/grants').expect(200);

    expect(res.body).toHaveProperty('grants');
    expect(res.body).toHaveProperty('total');
    expect(res.body.grants.length).toBeGreaterThan(0);
    // Seeded grants are for the ADMIN role
    expect(res.body.grants[0].principalType).toBe(PrincipalType.ROLE);
  });

  it('GET /effective returns capabilities for admin', async () => {
    const app = createApp(adminUser);
    const res = await request(app).get('/api/admin/grants/effective').expect(200);

    expect(res.body).toHaveProperty('capabilities');
    expect(res.body.capabilities).toContain('access:admin');
    expect(res.body.capabilities).toContain('manage:roles');
  });

  it('POST / assigns a grant and DELETE / revokes it', async () => {
    const app = createApp(adminUser);

    // Assign
    const assignRes = await request(app)
      .post('/api/admin/grants')
      .send({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
        capability: 'read:users',
      })
      .expect(201);

    expect(assignRes.body.grant).toMatchObject({
      principalType: PrincipalType.ROLE,
      principalId: SystemRoles.USER,
      capability: 'read:users',
    });

    // Verify via GET
    const getRes = await request(app)
      .get(`/api/admin/grants/${PrincipalType.ROLE}/${SystemRoles.USER}`)
      .expect(200);

    expect(getRes.body.grants.some((g) => g.capability === 'read:users')).toBe(true);

    // Revoke
    await request(app)
      .delete(`/api/admin/grants/${PrincipalType.ROLE}/${SystemRoles.USER}/read:users`)
      .expect(200);

    // Verify revoked
    const afterRes = await request(app)
      .get(`/api/admin/grants/${PrincipalType.ROLE}/${SystemRoles.USER}`)
      .expect(200);

    expect(afterRes.body.grants.some((g) => g.capability === 'read:users')).toBe(false);
  });

  it('POST / returns 400 for non-existent role when checkRoleExists is wired', async () => {
    const app = createApp(adminUser);

    const res = await request(app)
      .post('/api/admin/grants')
      .send({
        principalType: PrincipalType.ROLE,
        principalId: 'nonexistent-role',
        capability: 'read:users',
      })
      .expect(400);

    expect(res.body.error).toBe('Role not found');
  });

  it('POST / returns 400 for a role only a tenant holds, as the roles API addresses it', async () => {
    const { tenantStorage } = require('@librechat/data-schemas');
    await tenantStorage.run({ tenantId: 'tenant-a' }, () =>
      db.createRoleByName({ name: 'tenant-only-role' }),
    );
    const app = createApp(adminUser);

    const res = await request(app)
      .post('/api/admin/grants')
      .send({
        principalType: PrincipalType.ROLE,
        principalId: 'tenant-only-role',
        capability: 'read:users',
      })
      .expect(400);

    expect(res.body.error).toBe('Role not found');
    expect(
      await mongoose.models.SystemGrant.countDocuments({ principalId: 'tenant-only-role' }),
    ).toBe(0);
    await mongoose.models.Role.deleteMany({ name: 'tenant-only-role' });
  });

  it('POST / returns 401 without authenticated user', async () => {
    const app = createApp(undefined);

    const res = await request(app)
      .post('/api/admin/grants')
      .send({
        principalType: PrincipalType.ROLE,
        principalId: SystemRoles.USER,
        capability: 'read:users',
      })
      .expect(401);

    expect(res.body).toHaveProperty('error', 'Authentication required');
  });
});
