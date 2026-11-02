import React, { forwardRef } from 'react';
import { SendIcon, IconButton, useLocalize, TooltipAnchor } from '@librechat/client';
import type { ForwardRefExoticComponent, RefAttributes } from 'react';
import { isSubmittableMessage } from '../../core/turns/draft';

type SendButtonProps = {
  disabled: boolean;
  /** The composer's current text; the host owns the input state. */
  text: string;
  /** Number of attached files; attachments allow sending without text */
  fileCount?: number;
};

const SubmitButton = React.memo(
  forwardRef((props: { disabled: boolean }, ref: React.ForwardedRef<HTMLButtonElement>) => {
    const localize = useLocalize();
    return (
      <TooltipAnchor
        description={localize('com_nav_send_message')}
        render={
          <IconButton
            ref={ref}
            label={localize('com_nav_send_message')}
            variant="submit"
            size="theme"
            shape="composer"
            disabled={props.disabled}
            data-testid="send-button"
            type="submit"
          >
            <span className="" data-state="closed">
              <SendIcon className="size-6" />
            </span>
          </IconButton>
        }
      />
    );
  }),
);
const SendButton: React.MemoExoticComponent<
  ForwardRefExoticComponent<SendButtonProps & RefAttributes<HTMLButtonElement>>
> = React.memo(
  forwardRef((props: SendButtonProps, ref: React.ForwardedRef<HTMLButtonElement>) => {
    const canSubmit = isSubmittableMessage(props.text, props.fileCount);
    return <SubmitButton ref={ref} disabled={props.disabled || !canSubmit} />;
  }),
);

export default SendButton;
