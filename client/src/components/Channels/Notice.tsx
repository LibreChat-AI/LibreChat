import { forwardRef } from 'react';
import { Alert, Button } from '@librechat/client';
import type { Ref } from 'react';

type NoticeProps = {
  variant?: 'error' | 'warning';
  message: string;
  role?: 'alert' | 'status';
  /** Receives the recovery action when focus code targets the button rather than the alert. */
  actionRef?: Ref<HTMLButtonElement>;
  action?: string;
  disabled?: boolean;
  onAction?: () => void;
};

/** One line of feedback with its recovery action inline, instead of a boxed button under it. */
const Notice = forwardRef<HTMLDivElement, NoticeProps>(function Notice(
  { variant = 'error', message, role, actionRef, action, disabled, onAction },
  ref,
) {
  return (
    <Alert ref={ref} role={role} tabIndex={-1} variant={variant} className="w-full">
      <p>
        {message}
        {action && onAction && (
          <>
            {' '}
            <Button
              ref={actionRef}
              type="button"
              variant="alert-action"
              disabled={disabled}
              onClick={onAction}
            >
              {action}
            </Button>
          </>
        )}
      </p>
    </Alert>
  );
});

export default Notice;
