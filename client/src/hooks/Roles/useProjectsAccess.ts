import { useContext, useMemo } from 'react';
import { Permissions, hasProjectsPermission } from 'librechat-data-provider';
import { AuthContext } from '~/hooks/AuthContext';

export type ProjectsAccess = {
  /** The role has loaded; before then nothing is allowed, which is not yet a refusal. */
  loaded: boolean;
  /** The role may see and work in Chat Projects; `/api/projects` refuses everything else. */
  canUse: boolean;
  /** The role may also create projects. */
  canCreate: boolean;
};

/**
 * The requester's Chat Projects permissions. Nothing is allowed until the role has loaded, and a
 * role stored before the `PROJECTS` permission existed holds its defaults, as on the server.
 */
export default function useProjectsAccess(): ProjectsAccess {
  const auth = useContext(AuthContext);
  const roleName = auth?.user?.role;
  const role = roleName != null && auth?.isAuthenticated ? auth.roles?.[roleName] : undefined;
  return useMemo(() => {
    if (role == null) {
      return { loaded: false, canUse: false, canCreate: false };
    }
    return {
      loaded: true,
      canUse: hasProjectsPermission(role.permissions, Permissions.USE),
      canCreate: hasProjectsPermission(role.permissions, Permissions.CREATE),
    };
  }, [role]);
}
