import { AccessRoleIds, PrincipalType, ResourceType } from 'librechat-data-provider';
import type { TPrincipal, TUpdateResourcePermissionsRequest } from 'librechat-data-provider';
import type { NextFunction, Request, Response } from 'express';

interface ArtifactAppOwnerRecord {
  createdBy: string;
}

export interface ArtifactAppSharingPolicyDeps {
  getArtifactAppsByIds: (ids: string[]) => Promise<ArtifactAppOwnerRecord[]>;
}

type ArtifactAppPermissionRequest = Request<
  { resourceType: string; resourceId: string },
  unknown,
  Partial<TUpdateResourcePermissionsRequest>
>;

function principalMatchesOwner(principal: TPrincipal, ownerId: string): boolean {
  return (
    principal.type === PrincipalType.USER &&
    (principal.id === ownerId || principal.idOnTheSource === ownerId)
  );
}

/**
 * Artifact Apps intentionally expose viewer-only sharing. Enforce that invariant at the
 * HTTP boundary instead of trusting the fixed-role client dialog, and protect the owner
 * recorded on the app from generic ACL mutations.
 */
export function createArtifactAppSharingPolicy(deps: ArtifactAppSharingPolicyDeps) {
  return async function enforceArtifactAppSharingPolicy(
    req: ArtifactAppPermissionRequest,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (req.params.resourceType !== ResourceType.ARTIFACT_APP) {
      next();
      return;
    }

    const updated = Array.isArray(req.body?.updated) ? req.body.updated : [];
    const removed = Array.isArray(req.body?.removed) ? req.body.removed : [];
    const invalidGrant = updated.some(
      (principal) => principal.accessRoleId !== AccessRoleIds.ARTIFACT_APP_VIEWER,
    );
    const roleGrant = updated.some((principal) => principal.type === PrincipalType.ROLE);
    const invalidPublicGrant =
      req.body?.public === true &&
      req.body.publicAccessRoleId !== AccessRoleIds.ARTIFACT_APP_VIEWER;

    if (invalidGrant || invalidPublicGrant) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Artifact Apps can only be shared with viewer access',
      });
      return;
    }

    if (roleGrant) {
      res.status(400).json({
        error: 'Bad Request',
        message: 'Artifact Apps cannot be shared with roles',
      });
      return;
    }

    const userMutations = [...updated, ...removed].filter(
      (principal) => principal.type === PrincipalType.USER,
    );

    try {
      const [app] = await deps.getArtifactAppsByIds([req.params.resourceId]);
      if (!app) {
        res.status(404).json({
          error: 'Not Found',
          message: 'Artifact App not found',
        });
        return;
      }

      if (userMutations.some((principal) => principalMatchesOwner(principal, app.createdBy))) {
        res.status(400).json({
          error: 'Bad Request',
          message: 'Artifact App owner permissions cannot be changed',
        });
        return;
      }
    } catch (_error) {
      res.status(500).json({
        error: 'Internal Server Error',
        message: 'Failed to validate Artifact App owner permissions',
      });
      return;
    }

    next();
  };
}
