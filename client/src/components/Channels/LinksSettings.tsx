import { dataService } from 'librechat-data-provider';
import { useAuthContext } from '~/hooks';
import Links from './Links';
import Dm from './Dm';

/** Remains revocable when the deployment disables new channel execution. */
export default function LinksSettings() {
  const { user } = useAuthContext();
  if (!user) return null;
  const principalKey = JSON.stringify([user.tenantId ?? '_', user.id]);
  return (
    <>
      <Links api={dataService.channelIdentityClient} principalKey={principalKey} />
      <Dm principalKey={principalKey} />
    </>
  );
}
