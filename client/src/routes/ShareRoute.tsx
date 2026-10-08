import { AuthContextProvider } from '~/hooks/AuthContext';
import ShareView from '~/components/Share/ShareView';

export default function ShareRoute() {
  return (
    <AuthContextProvider authConfig={{ loginRedirect: '/login', optional: true }}>
      <ShareView />
    </AuthContextProvider>
  );
}
