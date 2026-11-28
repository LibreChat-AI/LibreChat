import mongoose, { Types } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import { ResourceType, AccessRoleIds, PrincipalType } from 'librechat-data-provider';
import type { IAclEntry } from '@librechat/data-schemas';
import type { Model } from 'mongoose';
import { AccessControlService } from './accessControlService';

jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), warn: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

let mongoServer: MongoMemoryServer;
let AclEntry: Model<IAclEntry>;
let service: AccessControlService;
let methods: ReturnType<typeof createMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  /** Lock acquisition gives a cold index build only 2s, so finish it before the first write. */
  await mongoose.models.ResourceLock.createIndexes();
  AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
  methods = createMethods(mongoose);
  await methods.seedDefaultRoles();
  service = new AccessControlService(mongoose);
  /** Without the TTL index the background sweep cannot remove a row mid-test. */
  await AclEntry.init();
  await AclEntry.collection.dropIndex('expiredAt_1');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await AclEntry.deleteMany({});
});

const resourceType = ResourceType.SHARED_LINK;

async function seedExpiredViewer() {
  const userId = new Types.ObjectId();
  const resourceId = new Types.ObjectId();
  await methods.grantPermission(
    PrincipalType.USER,
    userId,
    resourceType,
    resourceId,
    1,
    userId,
    undefined,
    undefined,
    new Date(Date.now() - 60_000),
  );
  return { userId, resourceId };
}

describe('bulkUpdateResourcePermissions over expired, unswept entries', () => {
  it('deletes and audits a revoked expired entry so a share renewal cannot revive it', async () => {
    const { userId, resourceId } = await seedExpiredViewer();

    const results = await service.bulkUpdateResourcePermissions({
      resourceType,
      resourceId,
      revokedPrincipals: [{ type: PrincipalType.USER, id: userId.toString() }],
      grantedBy: userId,
    });
    await methods.updateSharedLinkAclExpiration(resourceId.toString(), null);

    expect(results.aclChanges).toEqual([
      expect.objectContaining({
        action: 'removed',
        previous: expect.objectContaining({ permBits: 1 }),
      }),
    ]);
    expect(await AclEntry.countDocuments({ resourceId })).toBe(0);
  });

  it('audits the stored expired entry as the previous state of a re-grant', async () => {
    const { userId, resourceId } = await seedExpiredViewer();

    const results = await service.bulkUpdateResourcePermissions({
      resourceType,
      resourceId,
      updatedPrincipals: [
        {
          type: PrincipalType.USER,
          id: userId.toString(),
          accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
        },
      ],
      grantedBy: userId,
    });

    expect(results.errors).toEqual([]);
    expect(results.aclChanges).toEqual([
      expect.objectContaining({
        action: 'assigned',
        previous: expect.objectContaining({ permBits: 1 }),
      }),
    ]);
    expect(await AclEntry.countDocuments({ resourceId })).toBe(1);
  });
});
