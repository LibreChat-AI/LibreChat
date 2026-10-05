import { Spinner } from '@librechat/client';
import { useLocalize } from '~/hooks';

/** Shown in place of an error page while the app reloads onto a newer deploy. */
export default function Updating() {
  const localize = useLocalize();

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-surface-primary text-text-secondary flex min-h-screen items-center justify-center gap-3 text-sm"
    >
      <Spinner />
      <span>{localize('com_ui_updating_latest_version')}</span>
    </div>
  );
}
