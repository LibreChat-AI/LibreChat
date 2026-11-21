import { forwardRef } from 'react';
import { Alert, Button } from '@librechat/client';

type NoticeProps = {
  variant?: 'error' | 'warning';
  message: string;
  action?: string;
  disabled?: boolean;
  onAction?: () => void;
};

/** One line of feedback with its recovery action inline, instead of a boxed button under it. */
const Notice = forwardRef<HTMLDivElement, NoticeProps>(function Notice(
  { variant = 'error', message, action, disabled, onAction },
  ref,
) {
  return (
    <Alert ref={ref} tabIndex={-1} variant={variant} className="w-full">
      <p>
        {message}
        {action && onAction && (
          <>
            {' '}
            <Button type="button" variant="alert-action" disabled={disabled} onClick={onAction}>
              {action}
            </Button>
          </>
        )}
      </p>
    </Alert>
  );
});

export default Notice;
