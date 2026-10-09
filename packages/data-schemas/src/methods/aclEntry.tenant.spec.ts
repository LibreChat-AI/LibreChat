import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { PrincipalType, PrincipalModel, PermissionBits } from 'librechat-data-provider';
import type { IAclEntry } from '..';
import { createAclEntryMethods } from './aclEntry';
import { createModels } from '../models';
import { tenantStorage } from '../config/tenantContext';

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
  await mongoServer.stop();
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
