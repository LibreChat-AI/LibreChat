import {
  SystemRoles,
  Permissions,
  ResourceType,
  PermissionBits,
  PermissionTypes,
  hasPermissions,
} from 'librechat-data-provider';
import type { TArtifactApp } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import { GenericGrantAccessDialog } from '~/components/Sharing';
import { useAuthContext, useHasAccess } from '~/hooks';

export function canShareArtifactApp({
  app,
  userId,
  userRole,
  hasAccessToShare,
  canViewUsers,
  canViewGroups,
  canSharePublic,
}: {
  app: TArtifactApp;
  userId?: string;
  userRole?: string;
  hasAccessToShare: boolean;
  canViewUsers: boolean;
  canViewGroups: boolean;
  canSharePublic: boolean;
}): boolean {
  if (!hasAccessToShare || !app.id) {
    return false;
  }
  if (!canViewUsers && !canViewGroups && !canSharePublic) {
    return false;
  }
  if (app.createdBy === userId || userRole === SystemRoles.ADMIN) {
    return true;
  }
  return hasPermissions(app.permissionBits ?? 0, PermissionBits.SHARE);
}

export function useCanShareArtifactApp(app: TArtifactApp): boolean {
  const { user } = useAuthContext();
  const hasAccessToShare = useHasAccess({
    permissionType: PermissionTypes.ARTIFACTS,
    permission: Permissions.SHARE,
  });
  const canViewUsers = useHasAccess({
    permissionType: PermissionTypes.PEOPLE_PICKER,
    permission: Permissions.VIEW_USERS,
  });
  const canViewGroups = useHasAccess({
    permissionType: PermissionTypes.PEOPLE_PICKER,
    permission: Permissions.VIEW_GROUPS,
  });
  const canSharePublic = useHasAccess({
    permissionType: PermissionTypes.ARTIFACTS,
    permission: Permissions.SHARE_PUBLIC,
  });
  return canShareArtifactApp({
    app,
    userId: user?.id,
    userRole: user?.role,
    hasAccessToShare,
    canViewUsers,
    canViewGroups,
    canSharePublic,
  });
}

export default function ArtifactAppShareDialog({
  app,
  children,
  buttonClassName,
  defaultOpen = false,
  onOpenChange,
}: {
  app: TArtifactApp;
  children?: ReactNode;
  buttonClassName?: string;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const canShare = useCanShareArtifactApp(app);
  if (!canShare) {
    return null;
  }

  return (
    <GenericGrantAccessDialog
      resourceDbId={app.id}
      resourceId={app.artifactAppId}
      resourceName={app.title}
      resourceType={ResourceType.ARTIFACT_APP}
      buttonClassName={buttonClassName}
      defaultOpen={defaultOpen}
      onOpenChange={onOpenChange}
    >
      {children}
    </GenericGrantAccessDialog>
  );
}
