import { ResourceType, PermissionBits } from 'librechat-data-provider';
import {
  getTenantId,
  runAsSystem,
  tenantStorage,
  activeExpirationFilter,
} from '@librechat/data-schemas';
import type { Request, Response, NextFunction } from 'express';
import type { IUser } from '@librechat/data-schemas';
import type { Types, Model } from 'mongoose';
import { AccessControlService } from '~/acl/accessControlService';
import { autoMigrateLegacyLink } from './service';
import { isEnabled } from '~/utils';

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

interface SharedLinkAccessRequest extends Request {
  shareResourceId?: string;
  shareTenantId?: string;
  shareConversationId?: string;
  shareOwnerId?: string;
}

export interface SharedLinkAccessDeps {
  mongoose: typeof import('mongoose');
  aclService?: AccessControlService;
}

function isAutoMigrateEnabled(): boolean {
  // Fallback for legacy rows missed by the explicit shared-link permissions migration.
  const val = process.env.SHARED_LINKS_AUTO_MIGRATE;
  return val === undefined || isEnabled(val);
}

export function createSharedLinkAccessMiddleware(deps: SharedLinkAccessDeps) {
  const { mongoose: mg } = deps;
  const aclService = deps.aclService ?? new AccessControlService(mg);

  async function hasPublicViewPermission(resourceId: string): Promise<boolean> {
    return aclService.hasPublicAccess({
      resourceType: ResourceType.SHARED_LINK,
      resourceId,
    });
  }

  return async function canAccessSharedLink(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const { shareId } = req.params;
    if (!shareId) {
      res.status(400).json({ message: 'Missing shareId' });
      return;
    }

    const viewerTenantId = getTenantId();
    const SharedLink = mg.models.SharedLink as Model<RawSharedLink>;
    const findShare = async () =>
      (await SharedLink.findOne({
        shareId,
        ...activeExpirationFilter<RawSharedLink>(),
      }).lean()) as RawSharedLink | null;
    // Resolve by the (globally unique, secret) shareId under the viewer's tenant
    // first, then fall back to a system-wide lookup so a share owned by another
    // tenant — e.g. a public link opened by an authenticated user from a
    // different tenant — still resolves. Access remains gated by the ACL check
    // below, which runs under the share's own tenant, so this only broadens the
    // lookup, never the authorization.
    let rawShare = viewerTenantId ? await findShare() : await runAsSystem(findShare);
    if (!rawShare && viewerTenantId) {
      rawShare = await runAsSystem(findShare);
    }

    if (!rawShare) {
      res.status(404).json({ message: 'Shared link not found' });
      return;
    }

    const resourceId = rawShare._id?.toString();
    if (!resourceId) {
      res.status(404).json({ message: 'Shared link not found' });
      return;
    }

    const continueRequest = (): void => {
      const sharedRequest = req as SharedLinkAccessRequest;
      sharedRequest.shareResourceId = resourceId;
      sharedRequest.shareTenantId = rawShare.tenantId;
      sharedRequest.shareConversationId = rawShare.conversationId;
      sharedRequest.shareOwnerId = rawShare.user;
      next();
    };

    const user = req.user as IUser | undefined;

    const runWithTenant = async (fn: () => Promise<void>): Promise<void> => {
      if (rawShare.tenantId) {
        return tenantStorage.run({ tenantId: rawShare.tenantId }, fn);
      }
      return runAsSystem(fn);
    };

    await runWithTenant(async () => {
      const isLegacy = 'isPublic' in rawShare;

      if (isLegacy) {
        if (!isAutoMigrateEnabled()) {
          res.status(403).json({ message: 'Legacy shared link requires migration' });
          return;
        }
        await autoMigrateLegacyLink(rawShare);
      }

      const publicGranted = await hasPublicViewPermission(resourceId);

      if (publicGranted) {
        if (isEnabled(process.env.ALLOW_SHARED_LINKS_PUBLIC)) {
          continueRequest();
          return;
        }

        if (!user) {
          res.status(401).json({ message: 'Authentication required' });
          return;
        }

        continueRequest();
        return;
      }

      if (!user) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }

      const userId = user.id ?? user._id?.toString();
      if (!userId) {
        res.status(401).json({ message: 'Authentication required' });
        return;
      }

      const hasAccess = await aclService.checkPermission({
        userId,
        // Trust the viewer's role only for a same-tenant view, comparing the share
        // tenant to the user's own tenantId (the ALS context is absent on cookie-auth
        // file requests). null suppresses the ROLE principal for cross-tenant views.
        role: rawShare.tenantId === user.tenantId ? user.role : null,
        resourceType: ResourceType.SHARED_LINK,
        resourceId,
        requiredPermission: PermissionBits.VIEW,
      });

      if (!hasAccess) {
        res.status(403).end();
        return;
      }

      continueRequest();
    });
  };
}
