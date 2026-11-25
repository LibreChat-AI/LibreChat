const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { createModels, tenantStorage, runAsSystem } = require('@librechat/data-schemas');
const { ResourceType, PrincipalType, PrincipalModel } = require('librechat-data-provider');

jest.mock('~/server/services/Config', () => ({
  invalidateCodeEnvironmentConfigCache: jest.fn(),
}));

const { getResourcePermissions } = require('../PermissionsController');

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

const createMockRes = () => {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
};

describe('getResourcePermissions accessroles tenant scoping', () => {
  let mongoServer;
  let AccessRole;
  let AclEntry;
  let User;

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({ instance: { args: ['--nounixsocket'] } });
    await mongoose.connect(mongoServer.getUri());
    createModels(mongoose);
    ({ AccessRole, AclEntry, User } = mongoose.models);
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  afterEach(async () => {
    await runAsSystem(async () => {
      await AccessRole.deleteMany({});
      await AclEntry.deleteMany({});
      await User.deleteMany({});
    });
  });

  const inTenant = (tenantId, fn) => tenantStorage.run({ tenantId }, fn);

  const createRole = (accessRoleId) =>
    AccessRole.create({
      accessRoleId,
      name: accessRoleId,
      resourceType: ResourceType.AGENT,
      permBits: 1,
    });

  const readAsTenantA = async (resourceId) => {
    const res = createMockRes();
    await inTenant(TENANT_A, () =>
      getResourcePermissions(
        {
          params: { resourceType: ResourceType.AGENT, resourceId: resourceId.toString() },
          user: { id: new mongoose.Types.ObjectId().toString(), role: 'USER', tenantId: TENANT_A },
        },
        res,
      ),
    );
    expect(res.status).toHaveBeenCalledWith(200);
    return res.json.mock.calls[0][0];
  };

  it('does not return a foreign tenant role label on a PUBLIC entry', async () => {
    const resourceId = new mongoose.Types.ObjectId();
    const foreignRole = await inTenant(TENANT_B, () => createRole('tenant_b_secret_role'));
    expect(foreignRole.tenantId).toBe(TENANT_B);

    await inTenant(TENANT_A, () =>
      AclEntry.create({
        principalType: PrincipalType.PUBLIC,
        resourceType: ResourceType.AGENT,
        resourceId,
        permBits: 1,
        roleId: foreignRole._id,
      }),
    );

    const body = await readAsTenantA(resourceId);
    expect(body.public).toBe(true);
    expect(body.publicAccessRoleId).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('tenant_b_secret_role');
  });

  it('keeps global default and same-tenant role labels', async () => {
    const resourceId = new mongoose.Types.ObjectId();
    const globalRole = await runAsSystem(() => createRole('agent_viewer'));
    expect(globalRole.tenantId).toBeUndefined();
    const ownRole = await inTenant(TENANT_A, () => createRole('tenant_a_editor'));
    const user = await inTenant(TENANT_A, () =>
      User.create({ name: 'A', email: 'a@a.test', provider: 'local' }),
    );

    await inTenant(TENANT_A, () =>
      AclEntry.create([
        {
          principalType: PrincipalType.PUBLIC,
          resourceType: ResourceType.AGENT,
          resourceId,
          permBits: 1,
          roleId: globalRole._id,
        },
        {
          principalType: PrincipalType.USER,
          principalId: user._id,
          principalModel: PrincipalModel.USER,
          resourceType: ResourceType.AGENT,
          resourceId,
          permBits: 3,
          roleId: ownRole._id,
        },
      ]),
    );

    const body = await readAsTenantA(resourceId);
    expect(body.publicAccessRoleId).toBe('agent_viewer');
    expect(body.principals).toEqual([
      expect.objectContaining({
        type: PrincipalType.USER,
        id: user._id.toString(),
        accessRoleId: 'tenant_a_editor',
      }),
    ]);
  });
});
