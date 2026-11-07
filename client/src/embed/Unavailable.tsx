import { Button, Spinner } from '@librechat/client';
import { apiBaseUrl } from 'librechat-data-provider';
import { useAuthContext, useLocalize } from '~/hooks';

/**
 * Shown in place of the login page inside a host page. Chat routes send an unauthenticated
 * visitor here after a short delay, which the host's token round trip can outlast, so this waits
 * for the sign-in to settle (the auth provider navigates back on success) and only reports a
 * failure once it has failed.
 */
export default function EmbedUnavailable() {
  const localize = useLocalize();
  const { isAuthReady, isAuthenticated } = useAuthContext();
  const retry = () => window.location.replace(`${apiBaseUrl()}/c/new`);

  if (!isAuthReady || isAuthenticated) {
    return (
      <main
        className="bg-surface-primary flex h-screen items-center justify-center"
        aria-busy="true"
        aria-label={localize('com_ui_loading')}
      >
        <Spinner />
      </main>
    );
  }

  return (
    <main className="bg-surface-primary text-text-primary flex h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <h1 className="text-lg font-semibold">{localize('com_embed_unavailable_title')}</h1>
      <p className="text-text-secondary max-w-sm text-sm">
        {localize('com_embed_unavailable_description')}
      </p>
      <Button variant="outline" onClick={retry}>
        {localize('com_ui_retry')}
      </Button>
    </main>
  );
}
