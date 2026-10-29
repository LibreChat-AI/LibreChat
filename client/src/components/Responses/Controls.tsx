import { useRef, useState } from 'react';
import { Button } from '@librechat/client';
import type { ReactNode } from 'react';
import { useResponseCancel } from '~/data-provider/Responses';
import { useLocalize } from '~/hooks';

export default function Controls({
  responseId,
  userId,
  tenantId,
  children,
}: {
  responseId: string;
  userId: string;
  tenantId?: string;
  children: ReactNode;
}) {
  const localize = useLocalize();
  const cancel = useResponseCancel(responseId, userId, tenantId);
  const inFlight = useRef(false);
  const [stopping, setStopping] = useState(false);
  const stop = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setStopping(true);
    try {
      await cancel.mutateAsync();
    } catch {
      // A failed acknowledgement can still mean cancellation reached the server.
      // Keep decisions disabled while the canonical owner view is refreshed.
    } finally {
      inFlight.current = false;
    }
  };
  return (
    <div className="space-y-4">
      {stopping && (
        <p role={cancel.isError ? 'alert' : 'status'} aria-live="polite">
          {localize(
            cancel.isError
              ? 'com_ui_response_review_stop_error'
              : 'com_ui_response_review_stopping',
          )}
        </p>
      )}
      <Button
        variant="destructive"
        onClick={stop}
        disabled={cancel.isLoading || (stopping && !cancel.isError)}
        aria-busy={cancel.isLoading}
      >
        {localize(cancel.isError ? 'com_ui_response_review_stop_retry' : 'com_ui_stop')}
      </Button>
      <fieldset disabled={stopping} className="space-y-4" aria-disabled={stopping}>
        {children}
      </fieldset>
    </div>
  );
}
