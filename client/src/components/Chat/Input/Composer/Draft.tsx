import { useWatch } from 'react-hook-form';
import { useDirection } from '@radix-ui/react-direction';
import { ComposerField, ComposerHints } from '@librechat/chat/components';
import type { ComposerFieldProps } from '@librechat/chat/components';
import type { Control } from 'react-hook-form';
import type { ComponentProps } from 'react';
import type { ChatDirection } from '~/store/chatDirection';
import type { ChatFormValues } from '~/common';

/** The draft text, subscribed here rather than in the form so a keystroke re-renders only the
 *  leaves that show it. */
function useDraftText(control: Control<ChatFormValues>): string {
  return useWatch({ control, name: 'text' }) ?? '';
}

type DraftFieldProps = Omit<ComposerFieldProps, 'value' | 'listening'> & {
  control: Control<ChatFormValues>;
  chatDirection: ChatDirection;
};

/** The composer field, fed the live draft. */
export function DraftField({
  control,
  chatDirection,
  textareaProps,
  ...props
}: DraftFieldProps): React.JSX.Element {
  const text = useDraftText(control);
  const interfaceDirection = useDirection();
  /** An empty `dir="auto"` field resolves to LTR, which would park an RTL interface's placeholder on
   *  the wrong edge, so the empty field follows the interface until text gives it a direction. */
  const autoDirection = text ? 'auto' : interfaceDirection;
  const dir = chatDirection === 'auto' ? autoDirection : chatDirection;
  return (
    <ComposerField
      {...props}
      value={text}
      /* The waveform stands in for the placeholder until words arrive, and is then the only
         thing drawn on that line. */
      listening={props.dictationActive && text.trim() === ''}
      textareaProps={{ ...textareaProps, dir }}
    />
  );
}

type DraftHintsProps = Omit<ComponentProps<typeof ComposerHints>, 'hasText'> & {
  control: Control<ChatFormValues>;
};

/** The composer hints, told whether the draft has text. */
export function DraftHints({ control, ...props }: DraftHintsProps): React.JSX.Element {
  const hasText = useDraftText(control).trim() !== '';
  return <ComposerHints {...props} hasText={hasText} />;
}
