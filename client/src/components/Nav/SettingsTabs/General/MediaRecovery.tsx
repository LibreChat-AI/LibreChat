import { useMediaRecoveryAccess } from '~/hooks/Media/useMediaRecoveryAccess';
import MediaRecovery from '~/components/Media/Recovery';

export default function MediaRecoverySetting() {
  const access = useMediaRecoveryAccess();
  if (!access.canRead) return null;
  return <MediaRecovery key={access.host.scope} host={access.host} canManage={access.canManage} />;
}
