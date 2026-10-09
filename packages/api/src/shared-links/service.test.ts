jest.mock('@librechat/data-schemas', () => ({
  ...jest.requireActual('@librechat/data-schemas'),
  logger: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() },
}));

import mongoose, { Types, Model } from 'mongoose';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { createModels, createMethods } from '@librechat/data-schemas';
import { PrincipalType, AccessRoleIds } from 'librechat-data-provider';
import type { IAclEntry, ISharedLink } from '@librechat/data-schemas';
import {
  autoMigrateLegacyLink,
  grantCreationPermissions,
  ensureLinkPermissions,
  updateSharedLinkPermissionsExpiration,
  deleteSharedLinkWithCleanup,
  deleteConvoSharedLinksWithCleanup,
  deleteAllSharedLinksWithCleanup,
} from './service';

let mongoServer: MongoMemoryServer;
let AclEntry: Model<IAclEntry>;
let SharedLink: Model<ISharedLink>;

beforeAll(async () => {
  mongoServer = await MongoMemoryServer.create();
  await mongoose.connect(mongoServer.getUri());
  createModels(mongoose);
  const methods = createMethods(mongoose);
  await methods.seedDefaultRoles();
  AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
  SharedLink = mongoose.models.SharedLink as Model<ISharedLink>;
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongoServer.stop();
});

beforeEach(async () => {
  await AclEntry.deleteMany({});
  await SharedLink.deleteMany({});
});

const userId = new Types.ObjectId().toString();

async function createTestLink(overrides: Partial<ISharedLink> = {}) {
  return SharedLink.create({
    shareId: `share-${Date.now()}-${Math.random()}`,
    conversationId: 'convo1',
    user: userId,
    messages: [],
    ...overrides,
  });
}

describe('autoMigrateLegacyLink', () => {
  async function createLegacyLink(isPublic: boolean) {
    const link = await createTestLink();
    await mongoose.connection
      .db!.collection('sharedlinks')
      .updateOne({ _id: link._id }, { $set: { isPublic } });
    return link;
  }

  async function createOwnerlessLegacyLink(isPublic: boolean) {
    const link = await SharedLink.create({
      shareId: `share-${Date.now()}-${Math.random()}`,
      conversationId: 'convo1',
      messages: [],
    });
    await mongoose.connection
      .db!.collection('sharedlinks')
      .updateOne({ _id: link._id }, { $set: { isPublic } });
    return link;
  }

  test('grants OWNER and PUBLIC VIEWER for public legacy link', async () => {
    const link = await createLegacyLink(true);
    await autoMigrateLegacyLink({
      _id: link._id,
      conversationId: link.conversationId,
      user: userId,
      shareId: link.shareId,
      isPublic: true,
    });

    const entries = await AclEntry.find({ resourceId: link._id }).lean();
    const hasOwner = entries.some((e) => e.principalType === PrincipalType.USER);
    const hasPublic = entries.some((e) => e.principalType === PrincipalType.PUBLIC);
    expect(hasOwner).toBe(true);
    expect(hasPublic).toBe(true);
  });

  test('grants OWNER only for private legacy link (isPublic: false)', async () => {
    const link = await createLegacyLink(false);
    await autoMigrateLegacyLink({
      _id: link._id,
      conversationId: link.conversationId,
      user: userId,
      shareId: link.shareId,
      isPublic: false,
    });

    const entries = await AclEntry.find({ resourceId: link._id }).lean();
    const hasOwner = entries.some((e) => e.principalType === PrincipalType.USER);
    const hasPublic = entries.some((e) => e.principalType === PrincipalType.PUBLIC);
    expect(hasOwner).toBe(true);
    expect(hasPublic).toBe(false);
  });

  test('grants PUBLIC VIEWER for ownerless public legacy link', async () => {
    const link = await createOwnerlessLegacyLink(true);
    await autoMigrateLegacyLink({
      _id: link._id,
      conversationId: link.conversationId,
      shareId: link.shareId,
      isPublic: true,
    });

    const entries = await AclEntry.find({ resourceId: link._id }).lean();
    const hasOwner = entries.some((e) => e.principalType === PrincipalType.USER);
    const hasPublic = entries.some((e) => e.principalType === PrincipalType.PUBLIC);
    expect(hasOwner).toBe(false);
    expect(hasPublic).toBe(true);
  });

  test('removes isPublic field from document', async () => {
    const link = await createLegacyLink(true);
    await autoMigrateLegacyLink({
      _id: link._id,
      conversationId: link.conversationId,
      user: userId,
      shareId: link.shareId,
      isPublic: true,
    });

    const rawDoc = await mongoose.connection
      .db!.collection('sharedlinks')
      .findOne({ _id: link._id });
    expect(rawDoc).not.toHaveProperty('isPublic');
  });

  test('preserves isPublic when grant fails, allowing retry on next access', async () => {
    const link = await createLegacyLink(true);
    const AccessRole = mongoose.models.AccessRole;
    await AccessRole.deleteOne({ accessRoleId: AccessRoleIds.SHARED_LINK_OWNER });

    try {
      await autoMigrateLegacyLink({
        _id: link._id,
        conversationId: link.conversationId,
        user: userId,
        shareId: link.shareId,
        isPublic: true,
      });

      const rawDoc = await mongoose.connection
        .db!.collection('sharedlinks')
        .findOne({ _id: link._id });
      expect(rawDoc).toHaveProperty('isPublic');
    } finally {
      const methods = createMethods(mongoose);
      await methods.seedDefaultRoles();
    }
  });

  test('is idempotent — does not duplicate ACL entries on repeated calls', async () => {
    const link = await createLegacyLink(true);
    const args = {
      _id: link._id,
      conversationId: link.conversationId,
      user: userId,
      shareId: link.shareId,
      isPublic: true,
    };
    await autoMigrateLegacyLink(args);
    await autoMigrateLegacyLink(args);

    const ownerEntries = await AclEntry.find({
      resourceId: link._id,
      principalType: PrincipalType.USER,
    }).lean();
    expect(ownerEntries).toHaveLength(1);
  });
});

describe('grantCreationPermissions', () => {
  test('creates OWNER and PUBLIC VIEWER AclEntries', async () => {
    const link = await createTestLink();
    await grantCreationPermissions(link._id, userId, true);

    const entries = await AclEntry.find({ resourceId: link._id }).lean();
    expect(entries).toHaveLength(2);

    const owner = entries.find((e) => e.principalType === PrincipalType.USER);
    expect(owner).toBeDefined();
    expect(owner!.principalId!.toString()).toBe(userId);

    const pub = entries.find((e) => e.principalType === PrincipalType.PUBLIC);
    expect(pub).toBeDefined();
  });

  test('creates only OWNER when grantPublic is false', async () => {
    const link = await createTestLink();
    await grantCreationPermissions(link._id, userId, false);

    const entries = await AclEntry.find({ resourceId: link._id }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0].principalType).toBe(PrincipalType.USER);
  });

  test('propagates shared link expiration to created AclEntries', async () => {
    const expiredAt = new Date(Date.now() + 60 * 60 * 1000);
    const link = await createTestLink({ expiredAt });

    await grantCreationPermissions(link._id, userId, true, expiredAt);

    const entries = await AclEntry.find({ resourceId: link._id }).lean();
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.expiredAt?.toISOString()).toBe(expiredAt.toISOString());
    }
  });

  test('deletes SharedLink when OWNER grant fails', async () => {
    const link = await createTestLink();

    try {
      const AccessRole = mongoose.models.AccessRole;
      await AccessRole.deleteOne({ accessRoleId: AccessRoleIds.SHARED_LINK_OWNER });

      await expect(grantCreationPermissions(link._id, userId, true)).rejects.toThrow();

      const linkAfter = await SharedLink.findById(link._id);
      expect(linkAfter).toBeNull();
    } finally {
      const methods = createMethods(mongoose);
      await methods.seedDefaultRoles();
    }
  });
});

describe('ensureLinkPermissions', () => {
  test('creates OWNER AclEntry for legacy link with no entries', async () => {
    const link = await createTestLink();

    const beforeCount = await AclEntry.countDocuments({ resourceId: link._id });
    expect(beforeCount).toBe(0);

    await ensureLinkPermissions(link._id, userId);

    const entries = await AclEntry.find({ resourceId: link._id }).lean();
    expect(entries).toHaveLength(1);
    expect(entries[0].principalType).toBe(PrincipalType.USER);
  });

  test('is idempotent — does not duplicate on repeated calls', async () => {
    const link = await createTestLink();

    await ensureLinkPermissions(link._id, userId);
    await ensureLinkPermissions(link._id, userId);

    const entries = await AclEntry.find({ resourceId: link._id }).lean();
    expect(entries).toHaveLength(1);
  });

  test('does not write when the owner grant is already in place', async () => {
    const link = await createTestLink();
    await ensureLinkPermissions(link._id, userId);
    const [granted] = await AclEntry.find({ resourceId: link._id }).lean();

    await ensureLinkPermissions(link._id, userId);

    const [after] = await AclEntry.find({ resourceId: link._id }).lean();
    // Rendering the badge must not keep re-granting: `grantedAt` has to stand still.
    expect(after.grantedAt?.toISOString()).toBe(granted.grantedAt?.toISOString());
  });

  test('still runs the legacy migration when the owner grant already exists', async () => {
    const link = await createTestLink();
    await ensureLinkPermissions(link._id, userId);
    // A legacy row keeps its marker until every grant it needs exists.
    await SharedLink.updateOne({ _id: link._id }, { $set: { isPublic: true } });

    await ensureLinkPermissions(link._id, userId);

    const migrated = await SharedLink.findById(link._id).lean();
    expect((migrated as { isPublic?: boolean } | null)?.isPublic).toBeUndefined();
  });

  test('does not delete the SharedLink on failure', async () => {
    const link = await createTestLink();
    const AccessRole = mongoose.models.AccessRole;
    await AccessRole.deleteOne({ accessRoleId: AccessRoleIds.SHARED_LINK_OWNER });

    try {
      await ensureLinkPermissions(link._id, userId);

      const linkAfter = await SharedLink.findById(link._id);
      expect(linkAfter).not.toBeNull();
    } finally {
      const methods = createMethods(mongoose);
      await methods.seedDefaultRoles();
    }
  });
});

describe('updateSharedLinkPermissionsExpiration', () => {
  test('sets and clears expiration on shared-link AclEntries', async () => {
    const link = await createTestLink();
    await grantCreationPermissions(link._id, userId, true);

    const expiredAt = new Date(Date.now() + 60 * 60 * 1000);
    await updateSharedLinkPermissionsExpiration(link._id, expiredAt);

    const expiringEntries = await AclEntry.find({ resourceId: link._id }).lean();
    expect(expiringEntries).toHaveLength(2);
    for (const entry of expiringEntries) {
      expect(entry.expiredAt?.toISOString()).toBe(expiredAt.toISOString());
    }

    await updateSharedLinkPermissionsExpiration(link._id, null);

    const retainedEntries = await AclEntry.find({ resourceId: link._id }).lean();
    for (const entry of retainedEntries) {
      expect(entry).not.toHaveProperty('expiredAt');
    }
  });
});

describe('deleteSharedLinkWithCleanup', () => {
  test('deletes link and triggers ACL cleanup', async () => {
    const link = await createTestLink();
    await grantCreationPermissions(link._id, userId, true);

    const result = await deleteSharedLinkWithCleanup(userId, link.shareId!);

    expect(result).toMatchObject({ success: true, shareId: link.shareId! });
    expect(result!._id).toBe(link._id.toString());

    const linkAfter = await SharedLink.findById(link._id);
    expect(linkAfter).toBeNull();

    // ACL cleanup is async (fire-and-forget), wait briefly
    await new Promise((r) => setTimeout(r, 100));
    const aclAfter = await AclEntry.find({ resourceId: link._id }).lean();
    expect(aclAfter).toHaveLength(0);
  });

  test('returns null when link not found', async () => {
    const result = await deleteSharedLinkWithCleanup(userId, 'nonexistent');
    expect(result).toBeNull();
  });
});

describe('deleteConvoSharedLinksWithCleanup', () => {
  test('deletes all links for conversation and cleans up ACLs', async () => {
    const link1 = await createTestLink({ conversationId: 'convo-a' });
    const link2 = await createTestLink({ conversationId: 'convo-a' });
    await grantCreationPermissions(link1._id, userId, true);
    await grantCreationPermissions(link2._id, userId, false);

    const result = await deleteConvoSharedLinksWithCleanup(userId, 'convo-a');

    expect(result.deletedCount).toBe(2);

    await new Promise((r) => setTimeout(r, 100));
    const aclAfter = await AclEntry.find({
      resourceId: { $in: [link1._id, link2._id] },
    }).lean();
    expect(aclAfter).toHaveLength(0);
  });
});

describe('deleteAllSharedLinksWithCleanup', () => {
  test('deletes all user links and cleans up ACLs', async () => {
    const link1 = await createTestLink({ conversationId: 'c1' });
    const link2 = await createTestLink({ conversationId: 'c2' });
    await grantCreationPermissions(link1._id, userId, true);
    await grantCreationPermissions(link2._id, userId, true);

    const result = await deleteAllSharedLinksWithCleanup(userId);

    expect(result.deletedCount).toBe(2);

    await new Promise((r) => setTimeout(r, 100));
    const aclAfter = await AclEntry.find({
      resourceId: { $in: [link1._id, link2._id] },
    }).lean();
    expect(aclAfter).toHaveLength(0);
  });
});
