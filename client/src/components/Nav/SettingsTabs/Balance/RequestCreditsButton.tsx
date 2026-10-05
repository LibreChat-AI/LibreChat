import { useState } from 'react';
import { Button, OGDialog, OGDialogTrigger, OGDialogTemplate } from '@librechat/client';
import { useCreditRequestStatus, useLocalize } from '~/hooks';

export default function RequestCreditsButton() {
  const localize = useLocalize();
  const [reason, setReason] = useState('');
  const { pendingCreditRequest, submit, isSubmitting } = useCreditRequestStatus();

  if (pendingCreditRequest) {
    return (
      <Button size="sm" variant="outline" disabled>
        {localize('com_nav_balance_request_sent')}
      </Button>
    );
  }

  return (
    <OGDialog>
      <OGDialogTrigger asChild>
        <Button size="sm" variant="outline" type="button">
          {localize('com_nav_balance_request_button')}
        </Button>
      </OGDialogTrigger>
      <OGDialogTemplate
        title={localize('com_nav_balance_request_confirm_title')}
        className="max-w-[450px]"
        main={
          <div className="flex w-full flex-col gap-2">
            <label
              htmlFor="request-credits-reason"
              className="text-text-primary text-left text-sm font-medium"
            >
              {localize('com_nav_balance_request_reason_label')}
            </label>
            <textarea
              id="request-credits-reason"
              className="border-border-light text-text-primary w-full rounded-xl border bg-transparent p-2"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={4}
              maxLength={500}
              placeholder={localize('com_nav_balance_request_reason_placeholder')}
            />
          </div>
        }
        selection={{
          selectHandler: () => submit(reason.trim() || undefined),
          selectText: localize('com_nav_balance_request_button'),
          isLoading: isSubmitting,
        }}
      />
    </OGDialog>
  );
}
