import { Button } from '@librechat/client';
import { apiBaseUrl } from 'librechat-data-provider';
import { useLocalize } from '~/hooks';

/** Shown in place of the login page when the host page could not sign the embedded user in. */
export default function EmbedUnavailable() {
  const localize = useLocalize();
  const retry = () => window.location.replace(`${apiBaseUrl()}/c/new`);

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
