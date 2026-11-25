import mongoose from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import {
  ResourceType,
  PrincipalType,
  PrincipalModel,
  PermissionBits,
} from 'librechat-data-provider';
import type * as t from '~/types';
import { createAclEntryMethods } from './aclEntry';
import aclEntrySchema from '~/schema/aclEntry';

let mongoServer: MongoMemoryServer;
let AclEntry: mongoose.Model<t.IAclEntry>;
let methods: ReturnType<typeof createAclEntryMethods>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  AclEntry = mongoose.models.AclEntry || mongoose.model('AclEntry', aclEntrySchema);
  methods = createAclEntryMethods(mongoose);
  await mongoose.connect(mongoServer.getUri());
  /** Without the TTL index the background sweep cannot remove a row mid-test. */
  await AclEntry.syncIndexes();
  await AclEntry.collection.dropIndex('expiredAt_1');
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer?.stop();
});

beforeEach(async () => {
  await AclEntry.deleteMany({});
});

const resourceType = ResourceType.SHARED_LINK;
const VIEW = PermissionBits.VIEW;

type Expiry = { expiredAt?: Date | null };

async function seed(expiry: Expiry) {
  const userId = new mongoose.Types.ObjectId();
  const resourceId = new mongoose.Types.ObjectId();
  await AclEntry.collection.insertMany([
    {
      principalType: PrincipalType.USER,
      principalId: userId,
      principalModel: PrincipalModel.USER,
      resourceType,
      resourceId,
      permBits: VIEW,
      ...expiry,
    },
    {
      principalType: PrincipalType.PUBLIC,
      resourceType,
      resourceId,
      permBits: VIEW,
      ...expiry,
    },
  ]);
  return {
    resourceId,
    user: [{ principalType: PrincipalType.USER, principalId: userId }],
    publicPrincipal: [{ principalType: PrincipalType.PUBLIC }],
  };
}

async function readAll({ resourceId, user, publicPrincipal }: Awaited<ReturnType<typeof seed>>) {
  const [userHas, publicHas, effective, batch, accessible, publicIds, entries] = await Promise.all([
    methods.hasPermission(user, resourceType, resourceId, VIEW),
    methods.hasPermission(publicPrincipal, resourceType, resourceId, VIEW),
    methods.getEffectivePermissions(user, resourceType, resourceId),
    methods.getEffectivePermissionsForResources(user, resourceType, [resourceId]),
    methods.findAccessibleResources(user, resourceType, VIEW),
    methods.findPublicResourceIds(resourceType, VIEW),
    methods.findEntriesByPrincipalsAndResource(
      [...user, ...publicPrincipal],
      resourceType,
      resourceId,
    ),
  ]);
  return {
    userHas,
    publicHas,
    effective,
    batch: batch.get(resourceId.toString()) ?? 0,
    accessible: accessible.map(String),
    publicIds: publicIds.map(String),
    entries: entries.length,
  };
}

describe('AclEntry reads ignore expired grants before the TTL sweep', () => {
  it('rejects grants whose expiredAt has passed', async () => {
    const seeded = await seed({ expiredAt: new Date(Date.now() - 60_000) });

    expect(await AclEntry.countDocuments({ resourceId: seeded.resourceId })).toBe(2);
    expect(await readAll(seeded)).toEqual({
      userHas: false,
      publicHas: false,
      effective: 0,
      batch: 0,
      accessible: [],
      publicIds: [],
      entries: 0,
    });
  });

  it('returns expired entries to a mutation snapshot that asks for them', async () => {
    const { resourceId, user, publicPrincipal } = await seed({
      expiredAt: new Date(Date.now() - 60_000),
    });

    const entries = await methods.findEntriesByPrincipalsAndResource(
      [...user, ...publicPrincipal],
      resourceType,
      resourceId,
      undefined,
      true,
      true,
    );

    expect(entries).toHaveLength(2);
  });

  it('rejects a grant expired through updateSharedLinkAclExpiration', async () => {
    const seeded = await seed({});
    await methods.updateSharedLinkAclExpiration(
      seeded.resourceId.toString(),
      new Date(Date.now() - 1_000),
    );

    expect(await methods.hasPermission(seeded.user, resourceType, seeded.resourceId, VIEW)).toBe(
      false,
    );
  });

  it.each<[string, Expiry]>([
    ['absent', {}],
    ['null', { expiredAt: null }],
    ['in the future', { expiredAt: new Date(Date.now() + 60 * 60_000) }],
  ])('honours grants whose expiredAt is %s', async (_label, expiry) => {
    const seeded = await seed(expiry);
    const id = seeded.resourceId.toString();

    expect(await readAll(seeded)).toEqual({
      userHas: true,
      publicHas: true,
      effective: VIEW,
      batch: VIEW,
      accessible: [id],
      publicIds: [id],
      entries: 2,
    });
  });
});
