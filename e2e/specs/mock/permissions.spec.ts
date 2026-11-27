import { expect, request as playwrightRequest, test } from '@playwright/test';
import { MongoClient, ObjectId } from 'mongodb';
import type { APIRequestContext } from '@playwright/test';
import type { Collection, Db } from 'mongodb';
import cleanupUser from '../../setup/cleanupUser';
import { applyRuntimeEnv } from '../../setup/runtimeEnv';

type TestUser = {
  email: string;
  name: string;
  password: string;
};

type UserDoc = {
  _id: ObjectId;
  email: string;
  name: string;
  tenantId?: string;
};

type GroupDoc = {
  _id: ObjectId;
  name: string;
  email?: string;
  tenantId?: string;
};

type AccessRoleDoc = {
  _id: ObjectId;
  accessRoleId: string;
  resourceType: string;
  permBits: number;
  tenantId?: string;
};

type PrincipalResponse = {
  type: string;
  id: string;
  email?: string;
  name?: string;
  accessRoleId: string;
};

type PermissionsResponse = {
  principals: PrincipalResponse[];
};

type AuthenticatedRequest = {
  api: APIRequestContext;
  token: string;
  role: string;
};

const CURRENT_TENANT_ID = 'e2e-acl-current';
const OTHER_TENANT_ID = 'e2e-acl-other';
const RESOURCE_TYPE_AGENT = 'agent';
const PRINCIPAL_TYPE_USER = 'user';
const PRINCIPAL_TYPE_GROUP = 'group';
const PRINCIPAL_MODEL_USER = 'User';
const PRINCIPAL_MODEL_GROUP = 'Group';
const ACCESS_ROLE_AGENT_OWNER = 'agent_owner';
const ACCESS_ROLE_AGENT_VIEWER = 'agent_viewer';
const PERM_BITS_VIEWER = 1;
const PERM_BITS_OWNER = 15;

const randomSuffix = () => `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

async function connectToE2EDb() {
  applyRuntimeEnv();
  if (!process.env.MONGO_URI) {
    throw new Error('MONGO_URI must be available for permissions mock e2e tests');
  }

  const client = new MongoClient(process.env.MONGO_URI);
  await client.connect();
  return { client, db: client.db() };
}

async function createAuthenticatedRequest(
  baseURL: string,
  user: TestUser,
  tenantId: string,
): Promise<AuthenticatedRequest> {
  await cleanupUser(user);

  const api = await playwrightRequest.newContext({
    baseURL,
    storageState: { cookies: [], origins: [] },
    extraHTTPHeaders: {
      'X-Tenant-Id': tenantId,
    },
  });

  const registerResponse = await api.post('/api/auth/register', {
    data: {
      email: user.email,
      name: user.name,
      password: user.password,
      confirm_password: user.password,
    },
  });
  expect(registerResponse.ok()).toBeTruthy();

  const loginResponse = await api.post('/api/auth/login', {
    data: {
      email: user.email,
      password: user.password,
    },
  });
  expect(loginResponse.ok()).toBeTruthy();
  const loginPayload = (await loginResponse.json()) as { token?: string; user?: { role?: string } };
  if (!loginPayload.token || !loginPayload.user?.role) {
    throw new Error('Expected login response to include a bearer token and user role');
  }

  return {
    api,
    token: loginPayload.token,
    role: loginPayload.user.role,
  };
}

async function seedTenantRole(db: Db, tenantId: string, roleName: string) {
  await db.collection('roles').updateOne(
    { name: roleName, tenantId },
    {
      $set: {
        name: roleName,
        tenantId,
        permissions: {
          AGENTS: {
            USE: true,
            CREATE: true,
            SHARE: true,
            SHARE_PUBLIC: true,
          },
        },
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
      $currentDate: {
        updatedAt: true,
      },
    },
    { upsert: true },
  );
}

async function seedAccessRole(
  accessRoles: Collection<AccessRoleDoc>,
  tenantId: string,
  accessRoleId: string,
  permBits: number,
): Promise<AccessRoleDoc> {
  await accessRoles.updateOne(
    { accessRoleId, tenantId },
    {
      $set: {
        accessRoleId,
        tenantId,
        resourceType: RESOURCE_TYPE_AGENT,
        permBits,
        name: accessRoleId,
      },
      $setOnInsert: {
        createdAt: new Date(),
      },
      $currentDate: {
        updatedAt: true,
      },
    },
    { upsert: true },
  );

  const role = await accessRoles.findOne({ accessRoleId, tenantId });
  if (!role) {
    throw new Error(`Expected seeded access role ${accessRoleId}`);
  }
  return role;
}

test.describe('permission principal details', () => {
  test.setTimeout(120000);

  test('keeps permission details and local principal writes in the authenticated context', async ({
    baseURL,
  }) => {
    if (typeof baseURL !== 'string') {
      throw new Error('baseURL must be configured for permissions mock e2e tests');
    }

    const suffix = randomSuffix();
    const ownerUser: TestUser = {
      email: `acl-owner-${suffix}@example.com`,
      name: `ACL Owner ${suffix}`,
      password: 'securepassword123',
    };

    const { api, role, token } = await createAuthenticatedRequest(
      baseURL,
      ownerUser,
      CURRENT_TENANT_ID,
    );
    const { client, db } = await connectToE2EDb();
    const users = db.collection<UserDoc>('users');
    const groups = db.collection<GroupDoc>('groups');
    const aclEntries = db.collection('aclentries');
    const accessRoles = db.collection<AccessRoleDoc>('accessroles');
    const resourceId = new ObjectId();
    const createdIds: ObjectId[] = [];

    try {
      await seedTenantRole(db, CURRENT_TENANT_ID, role);
      const ownerRole = await seedAccessRole(
        accessRoles,
        CURRENT_TENANT_ID,
        ACCESS_ROLE_AGENT_OWNER,
        PERM_BITS_OWNER,
      );
      const viewerRole = await seedAccessRole(
        accessRoles,
        CURRENT_TENANT_ID,
        ACCESS_ROLE_AGENT_VIEWER,
        PERM_BITS_VIEWER,
      );

      const currentOwner = await users.findOne({
        email: ownerUser.email,
        tenantId: CURRENT_TENANT_ID,
      });
      if (!currentOwner) {
        throw new Error('Expected authenticated e2e user to be stored with a tenant id');
      }

      const outsideUserId = new ObjectId();
      const outsideGroupId = new ObjectId();
      const outsideWriteUserId = new ObjectId();
      const currentGroupId = new ObjectId();
      createdIds.push(outsideUserId, outsideGroupId, outsideWriteUserId, currentGroupId);

      await users.insertMany([
        {
          _id: outsideUserId,
          email: `outside-read-${suffix}@example.com`,
          name: `Outside Read User ${suffix}`,
          tenantId: OTHER_TENANT_ID,
        },
        {
          _id: outsideWriteUserId,
          email: `outside-write-${suffix}@example.com`,
          name: `Outside Write User ${suffix}`,
          tenantId: OTHER_TENANT_ID,
        },
      ]);
      await groups.insertMany([
        {
          _id: outsideGroupId,
          email: `outside-group-${suffix}@example.com`,
          name: `Outside Group ${suffix}`,
          tenantId: OTHER_TENANT_ID,
        },
        {
          _id: currentGroupId,
          email: `current-group-${suffix}@example.com`,
          name: `Current Group ${suffix}`,
          tenantId: CURRENT_TENANT_ID,
        },
      ]);

      await aclEntries.insertMany([
        {
          principalType: PRINCIPAL_TYPE_USER,
          principalId: currentOwner._id,
          principalModel: PRINCIPAL_MODEL_USER,
          resourceType: RESOURCE_TYPE_AGENT,
          resourceId,
          permBits: ownerRole.permBits,
          roleId: ownerRole._id,
          grantedBy: currentOwner._id,
          tenantId: CURRENT_TENANT_ID,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          principalType: PRINCIPAL_TYPE_USER,
          principalId: outsideUserId,
          principalModel: PRINCIPAL_MODEL_USER,
          resourceType: RESOURCE_TYPE_AGENT,
          resourceId,
          permBits: viewerRole.permBits,
          roleId: viewerRole._id,
          grantedBy: currentOwner._id,
          tenantId: CURRENT_TENANT_ID,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          principalType: PRINCIPAL_TYPE_GROUP,
          principalId: outsideGroupId,
          principalModel: PRINCIPAL_MODEL_GROUP,
          resourceType: RESOURCE_TYPE_AGENT,
          resourceId,
          permBits: viewerRole.permBits,
          roleId: viewerRole._id,
          grantedBy: currentOwner._id,
          tenantId: CURRENT_TENANT_ID,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const authHeaders = { Authorization: `Bearer ${token}` };

      const getResponse = await api.get(`/api/permissions/${RESOURCE_TYPE_AGENT}/${resourceId}`, {
        headers: authHeaders,
      });
      expect(getResponse.ok()).toBeTruthy();
      const getPayload = (await getResponse.json()) as PermissionsResponse;
      const serializedGetPayload = JSON.stringify(getPayload);

      expect(getPayload.principals).toEqual([
        expect.objectContaining({
          type: PRINCIPAL_TYPE_USER,
          id: currentOwner._id.toString(),
          email: ownerUser.email,
          accessRoleId: ACCESS_ROLE_AGENT_OWNER,
        }),
      ]);
      expect(serializedGetPayload).not.toContain(`outside-read-${suffix}@example.com`);
      expect(serializedGetPayload).not.toContain(`outside-group-${suffix}@example.com`);
      expect(serializedGetPayload).not.toContain(outsideUserId.toString());
      expect(serializedGetPayload).not.toContain(outsideGroupId.toString());

      const putResponse = await api.put(`/api/permissions/${RESOURCE_TYPE_AGENT}/${resourceId}`, {
        headers: authHeaders,
        data: {
          updated: [
            {
              type: PRINCIPAL_TYPE_GROUP,
              id: currentGroupId.toString(),
              name: `Current Group ${suffix}`,
              source: 'local',
              accessRoleId: ACCESS_ROLE_AGENT_VIEWER,
            },
            {
              type: PRINCIPAL_TYPE_USER,
              id: outsideWriteUserId.toString(),
              name: `Outside Write User ${suffix}`,
              email: `outside-write-${suffix}@example.com`,
              source: 'local',
              accessRoleId: ACCESS_ROLE_AGENT_VIEWER,
            },
          ],
          removed: [],
        },
      });
      expect(putResponse.ok()).toBeTruthy();
      const putPayload = (await putResponse.json()) as { results: PermissionsResponse };
      const serializedPutPayload = JSON.stringify(putPayload);

      expect(putPayload.results.principals).toEqual([
        expect.objectContaining({
          type: PRINCIPAL_TYPE_GROUP,
          id: currentGroupId.toString(),
          accessRoleId: ACCESS_ROLE_AGENT_VIEWER,
        }),
      ]);
      expect(serializedPutPayload).not.toContain(outsideWriteUserId.toString());
      expect(serializedPutPayload).not.toContain(`outside-write-${suffix}@example.com`);
      await expect
        .poll(() =>
          aclEntries.countDocuments({
            resourceType: RESOURCE_TYPE_AGENT,
            resourceId,
            principalId: currentGroupId,
            tenantId: CURRENT_TENANT_ID,
          }),
        )
        .toBe(1);
      await expect
        .poll(() =>
          aclEntries.countDocuments({
            resourceType: RESOURCE_TYPE_AGENT,
            resourceId,
            principalId: outsideWriteUserId,
            tenantId: CURRENT_TENANT_ID,
          }),
        )
        .toBe(0);
    } finally {
      await Promise.all([
        aclEntries.deleteMany({ resourceId }),
        users.deleteMany({ _id: { $in: createdIds } }),
        groups.deleteMany({ _id: { $in: createdIds } }),
        db.collection('roles').deleteOne({ name: role, tenantId: CURRENT_TENANT_ID }),
        accessRoles.deleteMany({
          accessRoleId: { $in: [ACCESS_ROLE_AGENT_OWNER, ACCESS_ROLE_AGENT_VIEWER] },
          tenantId: CURRENT_TENANT_ID,
        }),
      ]);
      await client.close();
      await api.dispose();
      await cleanupUser(ownerUser);
    }
  });
});
