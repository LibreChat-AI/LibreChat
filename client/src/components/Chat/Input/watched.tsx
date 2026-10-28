import { forwardRef } from 'react';
import { useWatch } from 'react-hook-form';
import { SendButton, DuringRunSendButton } from '@librechat/chat/components';
import type { Control } from 'react-hook-form';
import type { ComponentProps } from 'react';
import type { ChatFormValues } from '~/common';

type Watched<P> = Omit<P, 'text'> & { control: Control<ChatFormValues> };

/** The package buttons take the text as a value; watching it here keeps a keystroke from
 *  re-rendering more than the button, as it did when the buttons subscribed themselves. */
export const WatchedSendButton = forwardRef<
  HTMLButtonElement,
  Watched<ComponentProps<typeof SendButton>>
>(function WatchedSendButton({ control, ...props }, ref) {
  const text = useWatch({ control, name: 'text' });
  return <SendButton ref={ref} text={text ?? ''} {...props} />;
});

export const WatchedDuringRunSendButton = forwardRef<
  HTMLButtonElement,
  Watched<ComponentProps<typeof DuringRunSendButton>>
>(function WatchedDuringRunSendButton({ control, ...props }, ref) {
  const text = useWatch({ control, name: 'text' });
  return <DuringRunSendButton ref={ref} text={text ?? ''} {...props} />;
});
