import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, PrincipalModel, PermissionBits } from 'librechat-data-provider';
import type { IAclEntry } from '..';
import { tenantStorage } from '../config/tenantContext';
import { createAclEntryMethods } from './aclEntry';
import { createModels } from '../models';

jest.mock('~/config/winston', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn(),
  debug: jest.fn(),
}));

const TENANT_A = 'tenant-aaaaaaaaaaaaaaaaaaaa';
const TENANT_B = 'tenant-bbbbbbbbbbbbbbbbbbbb';
const RESOURCE_TYPE = 'agent';

let mongoServer: MongoMemoryServer;
let AclEntry: mongoose.Model<IAclEntry>;
let methods: ReturnType<typeof createAclEntryMethods>;

function runAs<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ tenantId }, fn);
}

async function seedAcl(tenantId: string, doc: Record<string, unknown>): Promise<void> {
  await runAs(tenantId, async () => {
    await new AclEntry(doc).save();
  });
}

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  AclEntry = mongoose.models.AclEntry as mongoose.Model<IAclEntry>;
  methods = createAclEntryMethods(mongoose);
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await AclEntry.deleteMany({});
});

describe('AclEntry resource lookups are scoped to the active tenant', () => {
  it('findAccessibleResources returns only the current tenant resources', async () => {
    const principalId = new mongoose.Types.ObjectId();
    const resourceA = new mongoose.Types.ObjectId();
    const resourceB = new mongoose.Types.ObjectId();

    await seedAcl(TENANT_A, {
      principalType: PrincipalType.USER,
      principalModel: PrincipalModel.USER,
      principalId,
      resourceType: RESOURCE_TYPE,
      resourceId: resourceA,
      permBits: PermissionBits.VIEW,
    });
    await seedAcl(TENANT_B, {
      principalType: PrincipalType.USER,
      principalModel: PrincipalModel.USER,
      principalId,
      resourceType: RESOURCE_TYPE,
      resourceId: resourceB,
      permBits: PermissionBits.VIEW,
    });

    const principals = [{ principalType: PrincipalType.USER, principalId }];

    const aResources = await runAs(TENANT_A, () =>
      methods.findAccessibleResources(principals, RESOURCE_TYPE, PermissionBits.VIEW),
    );
    expect(aResources.map(String)).toEqual([String(resourceA)]);

    const bResources = await runAs(TENANT_B, () =>
      methods.findAccessibleResources(principals, RESOURCE_TYPE, PermissionBits.VIEW),
    );
    expect(bResources.map(String)).toEqual([String(resourceB)]);
  });

  it('findPublicResourceIds returns only the current tenant public resources', async () => {
    const publicA = new mongoose.Types.ObjectId();
    const publicB = new mongoose.Types.ObjectId();

    await seedAcl(TENANT_A, {
      principalType: PrincipalType.PUBLIC,
      resourceType: RESOURCE_TYPE,
      resourceId: publicA,
      permBits: PermissionBits.VIEW,
    });
    await seedAcl(TENANT_B, {
      principalType: PrincipalType.PUBLIC,
      resourceType: RESOURCE_TYPE,
      resourceId: publicB,
      permBits: PermissionBits.VIEW,
    });

    const aPublic = await runAs(TENANT_A, () =>
      methods.findPublicResourceIds(RESOURCE_TYPE, PermissionBits.VIEW),
    );
    expect(aPublic.map(String)).toEqual([String(publicA)]);

    const bPublic = await runAs(TENANT_B, () =>
      methods.findPublicResourceIds(RESOURCE_TYPE, PermissionBits.VIEW),
    );
    expect(bPublic.map(String)).toEqual([String(publicB)]);
  });
});

describe('AclEntry grants made as a unique entry', () => {
  it('create one entry in the active tenant when the same grant runs concurrently', async () => {
    const resourceId = new mongoose.Types.ObjectId();
    const grant = () =>
      methods.grantPermission(
        PrincipalType.PUBLIC,
        null,
        RESOURCE_TYPE,
        resourceId,
        PermissionBits.VIEW,
        undefined,
        undefined,
        undefined,
        undefined,
        true,
      );

    await runAs(TENANT_A, () => Promise.all(Array.from({ length: 8 }, grant)));

    const entries = await runAs(TENANT_A, () => AclEntry.find({ resourceId }).lean());
    expect(entries).toHaveLength(1);
    expect(entries[0].tenantId).toBe(TENANT_A);
  });
});

describe('findResourcePermissionEntries joins only roles the entry tenant can reference', () => {
  const db = () => mongoose.connection.db!;

  afterEach(async () => {
    await Promise.all(
      ['accessroles', 'users', 'groups'].map((name) => db().collection(name).deleteMany({})),
    );
  });

  async function seedRole(accessRoleId: string, tenantId?: string) {
    const _id = new mongoose.Types.ObjectId();
    await db()
      .collection('accessroles')
      .insertOne({
        _id,
        accessRoleId,
        name: accessRoleId,
        resourceType: RESOURCE_TYPE,
        permBits: 1,
        ...(tenantId && { tenantId }),
      });
    return _id;
  }

  it('drops a foreign tenant role label and keeps global and same-tenant labels', async () => {
    const resourceId = new mongoose.Types.ObjectId();
    const userId = new mongoose.Types.ObjectId();
    const groupId = new mongoose.Types.ObjectId();
    const [globalRole, ownRole, foreignRole] = await Promise.all([
      seedRole('agent_viewer'),
      seedRole('tenant_a_editor', TENANT_A),
      seedRole('tenant_b_secret_role', TENANT_B),
    ]);
    await db().collection('users').insertOne({
      _id: userId,
      tenantId: TENANT_A,
      name: 'Member',
      email: 'member@example.com',
      password: 'hashed-secret',
      totpSecret: 'totp-secret',
      role: 'USER',
    });
    await db()
      .collection('groups')
      .insertOne({
        _id: groupId,
        tenantId: TENANT_A,
        name: 'Team',
        source: 'local',
        memberIds: [userId.toString()],
      });
    const entry = { resourceType: RESOURCE_TYPE, resourceId, permBits: PermissionBits.VIEW };
    await seedAcl(TENANT_A, { ...entry, principalType: PrincipalType.PUBLIC, roleId: foreignRole });
    await seedAcl(TENANT_A, {
      ...entry,
      principalType: PrincipalType.USER,
      principalModel: PrincipalModel.USER,
      principalId: userId,
      roleId: ownRole,
    });
    await seedAcl(TENANT_A, {
      ...entry,
      principalType: PrincipalType.GROUP,
      principalModel: PrincipalModel.GROUP,
      principalId: groupId,
      roleId: globalRole,
    });

    const rows = await runAs(TENANT_A, () =>
      methods.findResourcePermissionEntries(RESOURCE_TYPE, resourceId.toString()),
    );
    const byType = Object.fromEntries(rows.map((row) => [row.principalType, row]));

    expect(rows).toHaveLength(3);
    expect(byType[PrincipalType.PUBLIC].accessRoleId).toBeUndefined();
    expect(byType[PrincipalType.USER].accessRoleId).toBe('tenant_a_editor');
    expect(byType[PrincipalType.GROUP].accessRoleId).toBe('agent_viewer');
    expect(byType[PrincipalType.USER].userInfo).toEqual({
      _id: userId,
      tenantId: TENANT_A,
      name: 'Member',
      email: 'member@example.com',
      role: 'USER',
    });
    expect(byType[PrincipalType.GROUP].groupInfo).toEqual({
      _id: groupId,
      tenantId: TENANT_A,
      name: 'Team',
      source: 'local',
    });
    expect(JSON.stringify(rows)).not.toMatch(/tenant_b_secret_role|hashed-secret|totp-secret/);
  });

  it('keeps only global role labels on a tenantless entry', async () => {
    const resourceId = new mongoose.Types.ObjectId();
    const [globalRole, tenantRole] = await Promise.all([
      seedRole('agent_viewer'),
      seedRole('tenant_a_editor', TENANT_A),
    ]);
    await AclEntry.collection.insertMany([
      {
        principalType: PrincipalType.PUBLIC,
        resourceType: RESOURCE_TYPE,
        resourceId,
        permBits: 1,
        roleId: tenantRole,
      },
      {
        principalType: PrincipalType.ROLE,
        principalId: 'USER',
        resourceType: RESOURCE_TYPE,
        resourceId,
        permBits: 1,
        roleId: globalRole,
      },
    ]);

    const rows = await methods.findResourcePermissionEntries(RESOURCE_TYPE, resourceId);
    const byType = Object.fromEntries(rows.map((row) => [row.principalType, row.accessRoleId]));

    expect(byType).toEqual({
      [PrincipalType.PUBLIC]: undefined,
      [PrincipalType.ROLE]: 'agent_viewer',
    });
  });
});
