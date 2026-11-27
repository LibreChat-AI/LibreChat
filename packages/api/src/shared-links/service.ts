import mongoose from 'mongoose';
import { logger, createMethods } from '@librechat/data-schemas';
import {
  PrincipalType,
  ResourceType,
  AccessRoleIds,
  PermissionBits,
} from 'librechat-data-provider';
import type { AllMethods } from '@librechat/data-schemas';
import type { Types } from 'mongoose';
import { AccessControlService } from '~/acl/accessControlService';

let _methods: AllMethods | undefined;
function getMethods(): AllMethods {
  return (_methods ??= createMethods(mongoose));
}

let _aclService: AccessControlService | null = null;
function getAclService(): AccessControlService {
  if (!_aclService) {
    _aclService = new AccessControlService(mongoose);
  }
  return _aclService;
}

interface RawSharedLink {
  _id?: string | Types.ObjectId;
  conversationId: string;
  title?: string;
  user?: string;
  shareId?: string;
  tenantId?: string;
  isPublic?: boolean;
  expiredAt?: Date;
}

/**
 * A grant is written for a link read earlier, and a deletion can remove the link and its entries
 * in between, which would leave the grant on a link that no longer exists. Every deletion removes
 * the link before its last sweep of the entries, so reading the link again after the write settles
 * it: a grant written before that sweep is removed by it, and one written after finds the link
 * gone here. Returns whether the link is gone.
 */
async function withdrawIfDeleted(resourceId: string): Promise<boolean> {
  if (await getMethods().findSharedLinkById(resourceId)) {
    return false;
  }
  await cleanupSharedLinkPermissions(resourceId);
  return true;
}

/**
 * The share page reads a link's config and its messages together, so the first view of a legacy
 * link runs this twice at once, in one process or two: both find no grant and both write one.
 * The grants are therefore made as unique entries, which the database refuses to insert twice.
 */
export async function autoMigrateLegacyLink(share: RawSharedLink): Promise<void> {
  const shareId = share._id;
  if (!shareId) {
    return;
  }

  const resourceId = shareId.toString();
  let ownerGranted = false;
  let publicGranted = false;
  let existingOwner = false;
  /** A grant that failed may still have been written, so any attempt is checked afterwards. */
  let attempted = false;
  if (share.user) {
    existingOwner = await getAclService().checkPermission({
      userId: share.user,
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
      requiredPermission: PermissionBits.DELETE,
    });

    if (!existingOwner) {
      attempted = true;
      try {
        await getAclService().grantPermission({
          principalType: PrincipalType.USER,
          principalId: share.user,
          resourceType: ResourceType.SHARED_LINK,
          resourceId,
          accessRoleId: AccessRoleIds.SHARED_LINK_OWNER,
          grantedBy: share.user,
          expiredAt: share.expiredAt,
          uniqueEntry: true,
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
      attempted = true;
      try {
        await getAclService().grantPermission({
          principalType: PrincipalType.PUBLIC,
          principalId: null,
          resourceType: ResourceType.SHARED_LINK,
          resourceId,
          accessRoleId: AccessRoleIds.SHARED_LINK_VIEWER,
          grantedBy: share.user,
          expiredAt: share.expiredAt,
          uniqueEntry: true,
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

  if (attempted && (await withdrawIfDeleted(resourceId))) {
    return;
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

  await getMethods().clearSharedLinkLegacyVisibility(resourceId);

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
    await Promise.all([
      getMethods().deleteSharedLinkById(resourceId),
      cleanupSharedLinkPermissions(resourceId),
    ]);
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
        getMethods().deleteSharedLinkById(resourceId),
        getAclService().removeAllPermissions({
          resourceType: ResourceType.SHARED_LINK,
          resourceId,
        }),
      ]);
      throw err;
    }
  }

  await withdrawIfDeleted(resourceId);
}

export async function ensureLinkPermissions(
  sharedLinkId: string | Types.ObjectId,
  userId: string,
): Promise<void> {
  const rawDoc = await getMethods().findSharedLinkById(sharedLinkId.toString());

  if (!rawDoc) {
    return;
  }

  /* A legacy row keeps its marker until every grant it needs exists, so it always goes
   * back through the migration: the owner grant alone does not mean the public one was
   * ever created. `autoMigrateLegacyLink` skips the grants that are already in place. */
  if ('isPublic' in rawDoc) {
    await autoMigrateLegacyLink(rawDoc);
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
  await withdrawIfDeleted(sharedLinkId.toString());
}

export async function cleanupSharedLinkPermissions(
  resourceId: string | Types.ObjectId,
): Promise<{ acknowledged: boolean; deletedCount: number }> {
  return getMethods().deleteSharedLinkAclEntries([resourceId.toString()]);
}

export async function cleanupBulkSharedLinkPermissions(
  resourceIds: (string | Types.ObjectId)[],
): Promise<{ acknowledged: boolean; deletedCount: number }> {
  return getMethods().deleteSharedLinkAclEntries(resourceIds.map((id) => id.toString()));
}

export async function updateSharedLinkPermissionsExpiration(
  resourceId: string | Types.ObjectId,
  expiredAt: Date | null,
): Promise<void> {
  await getMethods().updateSharedLinkAclExpiration(resourceId.toString(), expiredAt);
}

export async function deleteSharedLinkWithCleanup(
  user: string,
  shareId: string,
): Promise<{ _id?: string; success: boolean; shareId: string; message: string } | null> {
  const result = await getMethods().deleteSharedLink(user, shareId);
  if (!result) {
    return null;
  }
  if (result._id) {
    cleanupSharedLinkPermissions(result._id).catch((err) => {
      logger.error('[deleteSharedLinkWithCleanup] ACL cleanup failed', {
        shareId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return result;
}

export async function deleteConvoSharedLinksWithCleanup(
  user: string,
  conversationId: string,
): Promise<{ message: string; deletedCount: number }> {
  const { deletedIds, ...result } = await getMethods().deleteConvoSharedLink(user, conversationId);
  if (deletedIds.length > 0) {
    cleanupBulkSharedLinkPermissions(deletedIds).catch((err) => {
      logger.error('[deleteConvoSharedLinksWithCleanup] ACL cleanup failed', {
        conversationId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return result;
}

export async function deleteAllSharedLinksWithCleanup(
  user: string,
  options: { awaitCleanup?: boolean } = {},
): Promise<{ message: string; deletedCount: number }> {
  /**
   * The cleanup before the delete keeps the links as the retry anchor when it fails, and it keeps
   * the owner's grants, which name the links once their rows are gone. A request that read a link
   * before the delete can still grant on it after that cleanup, so the sweep after the delete
   * removes every entry of the links those grants name, and a retry after it failed finds them.
   */
  const { deletedIds, ...result } = await getMethods().deleteAllSharedLinks(
    user,
    options.awaitCleanup
      ? async (ids) => {
          if (ids.length > 0) {
            await getMethods().deleteSharedLinkAclEntries(ids, user);
          }
        }
      : undefined,
  );
  if (options.awaitCleanup) {
    const owned = (
      await getMethods().getSoleOwnedResourceIds(
        new mongoose.Types.ObjectId(user),
        ResourceType.SHARED_LINK,
      )
    ).map((id) => id.toString());
    const live = new Set(await getMethods().findExistingSharedLinkIds(owned));
    const gone = new Set([...deletedIds, ...owned.filter((id) => !live.has(id))]);
    if (gone.size > 0) {
      await cleanupBulkSharedLinkPermissions([...gone]);
    }
  }
  if (!options.awaitCleanup && deletedIds.length > 0) {
    cleanupBulkSharedLinkPermissions(deletedIds).catch((err) => {
      logger.error('[deleteAllSharedLinksWithCleanup] ACL cleanup failed', {
        user,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
  return result;
}
