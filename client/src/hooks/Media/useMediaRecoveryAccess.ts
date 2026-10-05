import { mediaSessionScope, useMediaSessionGuard } from '~/components/Media/session';
import { useMediaRecoveryCapabilities } from '~/data-provider';
import { useAuthContext } from '~/hooks/AuthContext';

export function useMediaRecoveryAccess() {
  const { user, isAuthenticated } = useAuthContext();
  const scope = user ? mediaSessionScope(user) : '';
  const isCurrentSession = useMediaSessionGuard(scope, isAuthenticated);
  const host = { scope, isCurrentSession };
  const query = useMediaRecoveryCapabilities(host, isAuthenticated && !!scope);
  return {
    host,
    canRead: isAuthenticated && query.data?.canRead === true,
    canManage: isAuthenticated && query.data?.canManage === true,
  };
}
