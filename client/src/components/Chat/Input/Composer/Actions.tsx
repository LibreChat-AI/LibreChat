import { useWatch } from 'react-hook-form';
import { ComposerActions } from '@librechat/chat/components';
import type { ComposerActionsProps } from '@librechat/chat/components';
import { useChatFormContext } from '~/Providers';

/**
 * The composer's action slot with its own subscription to the draft. The element
 * built from this goes to `memo(Bar)` as a prop, so it must not carry the text:
 * a prop that changes with the draft re-renders the whole bar per keystroke.
 */
export default function Actions(props: Omit<ComposerActionsProps, 'text'>) {
  const { control } = useChatFormContext();
  const text = useWatch({ control, name: 'text' });
  return <ComposerActions {...props} text={text ?? ''} />;
}
