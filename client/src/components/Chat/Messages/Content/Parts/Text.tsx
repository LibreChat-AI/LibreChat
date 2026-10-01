import { memo, useMemo, ReactElement } from 'react';
import MarkdownLite from '~/components/Chat/Messages/Content/MarkdownLite';
import useSmoothStreaming from '~/hooks/Messages/useSmoothStreaming';
import Markdown from '~/components/Chat/Messages/Content/Markdown';
import { useMessagePartsHost } from '~/hooks/Chat/parts';
import CollapsibleText from './CollapsibleText';
import { cn } from '~/utils';

type TextPartProps = {
  text: string;
  showCursor: boolean;
  isCreatedByUser: boolean;
};

type ContentType =
  | ReactElement<React.ComponentProps<typeof Markdown>>
  | ReactElement<React.ComponentProps<typeof MarkdownLite>>
  | ReactElement;

const TextPart = memo(function TextPart({ text, isCreatedByUser, showCursor }: TextPartProps) {
  const { useMessage, useUserTextPreferences } = useMessagePartsHost();
  const { isSubmitting = false, isLatestMessage = false } = useMessage();
  const { enableUserMsgMarkdown, collapseLongUserMessages } = useUserTextPreferences();
  const smoothStreaming = useSmoothStreaming();
  // The word fade itself indicates streaming, so the trailing block cursor
  // only shows when the fade is unavailable (setting off or reduced motion).
  const showCursorState = useMemo(
    () => showCursor && isSubmitting && !(smoothStreaming && !isCreatedByUser),
    [showCursor, isSubmitting, smoothStreaming, isCreatedByUser],
  );

  const content: ContentType = useMemo(() => {
    if (!isCreatedByUser) {
      return <Markdown content={text} isLatestMessage={isLatestMessage} />;
    } else if (enableUserMsgMarkdown) {
      return <MarkdownLite content={text} />;
    } else {
      return <>{text}</>;
    }
  }, [isCreatedByUser, enableUserMsgMarkdown, text, isLatestMessage]);

  return (
    <CollapsibleText enabled={isCreatedByUser && collapseLongUserMessages}>
      <div
        className={cn(
          isSubmitting ? 'submitting' : '',
          showCursorState && !!text.length ? 'result-streaming' : '',
          'markdown prose message-content dark:prose-invert light w-full break-words',
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
