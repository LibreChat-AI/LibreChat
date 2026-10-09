import mongoose from 'mongoose';
import { logger } from '@librechat/data-schemas';
import {
  PrincipalType,
  ResourceType,
  AccessRoleIds,
  PermissionBits,
} from 'librechat-data-provider';
import type { Model, Types, DeleteResult, UpdateQuery } from 'mongoose';
import type { IAclEntry, ISharedLink } from '@librechat/data-schemas';
import { AccessControlService } from '~/acl/accessControlService';

let _aclService: AccessControlService | null = null;
function getAclService(): AccessControlService {
  if (!_aclService) {
    _aclService = new AccessControlService(mongoose);
  }
  return _aclService;
}

interface RawSharedLink {
  _id?: Types.ObjectId;
  conversationId: string;
  title?: string;
  user?: string;
  shareId?: string;
  tenantId?: string;
  isPublic?: boolean;
  expiredAt?: Date;
}

export async function autoMigrateLegacyLink(share: RawSharedLink): Promise<void> {
  const shareId = share._id;
  if (!shareId) {
    return;
  }

  const resourceId = shareId.toString();
  let ownerGranted = false;
  let publicGranted = false;
  let existingOwner = false;
  if (share.user) {
    existingOwner = await getAclService().checkPermission({
      userId: share.user,
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
      requiredPermission: PermissionBits.DELETE,
    });

    if (!existingOwner) {
      try {
        await getAclService().grantPermission({
          principalType: PrincipalType.USER,
          principalId: share.user,
          resourceType: ResourceType.SHARED_LINK,
          resourceId,
          accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
          grantedBy: share.user,
          expiredAt: share.expiredAt,
        });
        existingOwner = true;
        ownerGranted = true;
      } catch (err) {
        logger.error('[autoMigrateLegacyLink] Failed to grant OWNER', {
          shareId: share.shareId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  const needsPublicGrant = share.isPublic !== false;
  if (needsPublicGrant) {
    const hasPublic = await getAclService().hasPublicAccess({
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
    });

    if (!hasPublic) {
      try {
        await getAclService().grantPermission({
          principalType: PrincipalType.PUBLIC,
          principalId: null,
          resourceType: ResourceType.SHARED_LINK,
          resourceId,
          accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
          grantedBy: share.user,
          expiredAt: share.expiredAt,
        });
        publicGranted = true;
      } catch (err) {
        logger.error('[autoMigrateLegacyLink] Failed to grant PUBLIC VIEWER', {
          shareId: share.shareId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      publicGranted = true;
    }
  }

  const ownerOk = existingOwner || !share.user;
  const publicOk = publicGranted || !needsPublicGrant;

  if (!ownerOk || !publicOk) {
    logger.warn('[autoMigrateLegacyLink] Grants incomplete, keeping isPublic for retry', {
      shareId: share.shareId,
      ownerOk,
      publicOk,
    });
    return;
  }

  await mongoose.connection
    .db!.collection('sharedlinks')
    .updateOne({ _id: shareId }, { $unset: { isPublic: 1 } });

  logger.info('[autoMigrateLegacyLink] Migrated legacy shared link', {
    shareId: share.shareId,
    resourceId,
    ownerGranted,
    publicGranted,
  });
}

export async function grantCreationPermissions(
  sharedLinkId: string | Types.ObjectId,
  userId: string,
  grantPublic: boolean = true,
  expiredAt?: Date | null,
): Promise<void> {
  const resourceId = sharedLinkId.toString();

  try {
    await getAclService().grantPermission({
      principalType: PrincipalType.USER,
      principalId: userId,
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
      accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
      grantedBy: userId,
      expiredAt: expiredAt ?? undefined,
    });
  } catch (err) {
    logger.error('[grantCreationPermissions] OWNER grant failed, deleting SharedLink', {
      resourceId,
      error: err instanceof Error ? err.message : String(err),
    });
    await mongoose.models.SharedLink.deleteOne({ _id: sharedLinkId });
    throw err;
  }

  if (grantPublic) {
    try {
      await getAclService().grantPermission({
        principalType: PrincipalType.PUBLIC,
        principalId: null,
        resourceType: ResourceType.SHARED_LINK,
        resourceId,
        accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
        grantedBy: userId,
        expiredAt: expiredAt ?? undefined,
      });
    } catch (err) {
      logger.error('[grantCreationPermissions] PUBLIC VIEWER grant failed, cleaning up', {
        resourceId,
        error: err instanceof Error ? err.message : String(err),
      });
      await Promise.all([
        mongoose.models.SharedLink.deleteOne({ _id: sharedLinkId }),
        getAclService().removeAllPermissions({
          resourceType: ResourceType.SHARED_LINK,
          resourceId,
        }),
      ]);
      throw err;
    }
  }
}

export async function ensureLinkPermissions(
  sharedLinkId: string | Types.ObjectId,
  userId: string,
): Promise<void> {
  const SharedLink = mongoose.models.SharedLink as Model<ISharedLink>;
  const rawDoc = await SharedLink.findById(sharedLinkId).lean();

  if (!rawDoc) {
    return;
  }

  /* A legacy row keeps its marker until every grant it needs exists, so it always goes
   * back through the migration: the owner grant alone does not mean the public one was
   * ever created. `autoMigrateLegacyLink` skips the grants that are already in place. */
  if ('isPublic' in rawDoc) {
    await autoMigrateLegacyLink(rawDoc as Parameters<typeof autoMigrateLegacyLink>[0]);
    return;
  }

  /**
   * The share badge reads the link on ordinary navigation, so the settled path has to
   * stay read-only: re-granting on every open would turn a page load into an ACL write
   * and reset `grantedAt`. Only a link that still has no owner grant needs one.
   */
  const alreadyGranted = await getAclService().checkPermission({
    userId,
    resourceType: ResourceType.SHARED_LINK,
    resourceId: sharedLinkId.toString(),
    requiredPermission: PermissionBits.DELETE,
  });
  if (alreadyGranted) {
    return;
  }

  try {
    await getAclService().grantPermission({
      principalType: PrincipalType.USER,
      principalId: userId,
      resourceType: ResourceType.SHARED_LINK,
      resourceId: sharedLinkId.toString(),
      accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
      grantedBy: userId,
      expiredAt: rawDoc.expiredAt,
    });
  } catch (err) {
    logger.error('[ensureLinkPermissions] Failed to ensure OWNER AclEntry', {
      resourceId: sharedLinkId.toString(),
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function cleanupSharedLinkPermissions(
  resourceId: string | Types.ObjectId,
): Promise<DeleteResult> {
  return getAclService().removeAllPermissions({
    resourceType: ResourceType.SHARED_LINK,
    resourceId,
  });
}

export async function cleanupBulkSharedLinkPermissions(
  resourceIds: (string | Types.ObjectId)[],
): Promise<DeleteResult> {
  const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
  return AclEntry.deleteMany({
    resourceType: ResourceType.SHARED_LINK,
    resourceId: { $in: resourceIds },
  });
}

export async function updateSharedLinkPermissionsExpiration(
  resourceId: string | Types.ObjectId,
  expiredAt: Date | null,
): Promise<void> {
  const AclEntry = mongoose.models.AclEntry as Model<IAclEntry>;
  const update: UpdateQuery<IAclEntry> =
    expiredAt instanceof Date ? { $set: { expiredAt } } : { $unset: { expiredAt: 1 } };

  await AclEntry.updateMany(
    {
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
    },
    update,
  );
}

export async function deleteSharedLinkWithCleanup(
  user: string,
  shareId: string,
): Promise<{ _id?: string; success: boolean; shareId: string; message: string } | null> {
  const SharedLink = mongoose.models.SharedLink as Model<ISharedLink>;
  const result = await SharedLink.findOneAndDelete({ shareId, user }).lean();

  if (!result) {
    return null;
  }

  const resourceId = result._id;
  if (resourceId) {
    cleanupSharedLinkPermissions(resourceId).catch((err) => {
      logger.error('[deleteSharedLinkWithCleanup] ACL cleanup failed', {
        shareId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return {
    _id: resourceId?.toString(),
    success: true,
    shareId,
    message: 'Share deleted successfully',
  };
}

export async function deleteConvoSharedLinksWithCleanup(
  user: string,
  conversationId: string,
): Promise<{ message: string; deletedCount: number }> {
  const SharedLink = mongoose.models.SharedLink as Model<ISharedLink>;
  const links = await SharedLink.find({ user, conversationId }).select('_id').lean();
  const ids = links.map((l) => l._id);
  const result = await SharedLink.deleteMany({ user, conversationId });

  if (ids.length > 0) {
    cleanupBulkSharedLinkPermissions(ids).catch((err) => {
      logger.error('[deleteConvoSharedLinksWithCleanup] ACL cleanup failed', {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return {
    message: 'Shared links deleted successfully',
    deletedCount: result.deletedCount,
  };
}

export async function deleteAllSharedLinksWithCleanup(
  user: string,
): Promise<{ message: string; deletedCount: number }> {
  const SharedLink = mongoose.models.SharedLink as Model<ISharedLink>;
  const links = await SharedLink.find({ user }).select('_id').lean();
  const ids = links.map((l) => l._id);
  const result = await SharedLink.deleteMany({ user });

  if (ids.length > 0) {
    cleanupBulkSharedLinkPermissions(ids).catch((err) => {
      logger.error('[deleteAllSharedLinksWithCleanup] ACL cleanup failed', {
        user,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  return {
    message: 'All shared links deleted successfully',
    deletedCount: result.deletedCount,
  };
}
