import { memo, useMemo } from 'react';
import { cn } from '@librechat/client';
import type { ReactNode, NamedExoticComponent } from 'react';
import { useMessagePartsHost } from '../react/host';
import CollapsibleText from './CollapsibleText';

type TextPartProps = {
  text: string;
  showCursor: boolean;
  isCreatedByUser: boolean;
};

const TextPart: NamedExoticComponent<TextPartProps> = memo(function TextPart({
  text,
  isCreatedByUser,
  showCursor,
}: TextPartProps) {
  const { useMessage, useUserTextPreferences, useSmoothStreaming, renderMarkdown } =
    useMessagePartsHost();
  const { isSubmitting = false, isLatestMessage = false } = useMessage();
  const { enableUserMsgMarkdown, collapseLongUserMessages } = useUserTextPreferences();
  const smoothStreaming = useSmoothStreaming();
  // The word fade itself indicates streaming, so the trailing block cursor
  // only shows when the fade is unavailable (setting off or reduced motion).
  const showCursorState = useMemo(
    () => showCursor && isSubmitting && !(smoothStreaming && !isCreatedByUser),
    [showCursor, isSubmitting, smoothStreaming, isCreatedByUser],
  );

  const content: ReactNode = useMemo(() => {
    if (!isCreatedByUser) {
      return renderMarkdown({ content: text, variant: 'full', isLatestMessage });
    } else if (enableUserMsgMarkdown) {
      return renderMarkdown({ content: text, variant: 'lite', isLatestMessage });
    } else {
      return <>{text}</>;
    }
  }, [isCreatedByUser, enableUserMsgMarkdown, text, isLatestMessage, renderMarkdown]);

  return (
    <CollapsibleText enabled={isCreatedByUser && collapseLongUserMessages}>
      <div
        className={cn(
          isSubmitting ? 'submitting' : '',
          showCursorState && !!text.length ? 'result-streaming' : '',
          'markdown prose message-content light w-full break-words',
          isCreatedByUser && !enableUserMsgMarkdown && 'whitespace-pre-wrap',
          'text-text-primary',
        )}
      >
        {content}
      </div>
    </CollapsibleText>
  );
});
TextPart.displayName = 'TextPart';

export default TextPart;
