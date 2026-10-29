import { dataService } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';
import Links from './Links';

/** Remains revocable when the deployment disables new channel execution. */
export default function LinksSettings() {
  const { user } = useAuthContext();
  if (!user) return null;
  return (
    <Links
      api={dataService.channelIdentityClient}
      principalKey={`${user.tenantId ?? '_'}:${user.id}`}
    />
  );
}
