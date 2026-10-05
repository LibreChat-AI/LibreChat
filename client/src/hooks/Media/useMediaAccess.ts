import { useContext } from 'react';
import { Permissions, PermissionTypes } from 'librechat-data-provider';
import { mediaSessionScope } from '~/components/Media/session';
import { useGetStartupConfig } from '~/data-provider';
import { AuthContext } from '~/hooks/AuthContext';
import { useHasAccess } from '~/hooks';

export function useMediaAccess() {
  const auth = useContext(AuthContext);
  const startupQuery = useGetStartupConfig();
  const startup = startupQuery.data;
  const permitted = useHasAccess({
    permissionType: PermissionTypes.MEDIA,
    permission: Permissions.USE,
  });
  const canCreate = useHasAccess({
    permissionType: PermissionTypes.MEDIA,
    permission: Permissions.CREATE,
  });
  const media = startup?.media;
  const user = auth?.user;
  const isAuthenticated = auth?.isAuthenticated === true;
  const canUse = isAuthenticated && permitted;
  return {
    startup,
    startupQuery,
    media,
    user,
    scope: user ? mediaSessionScope(user) : undefined,
    isAuthenticated,
    isAuthReady: auth?.isAuthReady === true,
    enabled: canUse && media?.enabled === true,
    canUse,
    canCreate: canUse && canCreate && media?.canCreate === true,
    studio: canUse && media?.studio === true,
    chat: canUse && media?.chat === true,
  };
}
