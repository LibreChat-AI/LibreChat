import { useMemo } from 'react';
import { PermissionBits } from 'librechat-data-provider';
import type { TChatProject } from 'librechat-data-provider';

export interface ProjectPermissions {
  /** Caller created the project. */
  isOwner: boolean;
  /** The project was shared with the caller by someone else. */
  isShared: boolean;
  /** Caller can rename the project and change its description and instructions. */
  canEdit: boolean;
  /** Caller can attach and remove the project's files, which stay the owner's uploads. */
  canManageFiles: boolean;
  /** Caller can delete the project and manage who it is shared with. */
  canManage: boolean;
}

/**
 * Per-project permission checks for the workspace. The server marks a project shared with
 * the caller and sends their effective bits with it, so no extra request is needed; a
 * project without that mark is the caller's own.
 */
export default function useProjectPermissions(
  project: Pick<TChatProject, 'isShared' | 'permissions'> | undefined,
): ProjectPermissions {
  return useMemo<ProjectPermissions>(() => {
    const isShared = project?.isShared === true;
    if (!isShared) {
      return {
        isOwner: project != null,
        isShared: false,
        canEdit: project != null,
        canManageFiles: project != null,
        canManage: project != null,
      };
    }
    const bits = project?.permissions ?? PermissionBits.VIEW;
    return {
      isOwner: false,
      isShared: true,
      canEdit: (bits & PermissionBits.EDIT) !== 0,
      canManageFiles: false,
      canManage: false,
    };
  }, [project]);
}
