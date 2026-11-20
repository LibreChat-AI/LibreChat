import { Button } from '@librechat/client';
import useLocalize from '~/hooks/useLocalize';

function Retry({ onRetry, isRetrying = false }: { onRetry: () => void; isRetrying?: boolean }) {
  const localize = useLocalize();

  return (
    <div className="bg-surface-primary flex min-h-screen flex-col items-center justify-center p-6 text-center">
      <h1
        aria-live="polite"
        aria-atomic="true"
        className="text-text-primary mb-2 text-xl font-semibold"
      >
        {localize('com_auth_session_check_unavailable_title')}
      </h1>
      <p className="text-text-secondary mb-6 max-w-sm text-sm">
        {localize('com_auth_session_check_unavailable_body')}
      </p>
      <Button type="button" variant="submit" onClick={onRetry} disabled={isRetrying}>
        {isRetrying
          ? localize('com_auth_session_check_retrying')
          : localize('com_auth_session_check_retry')}
      </Button>
    </div>
  );
}

export default Retry;
