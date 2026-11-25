import { memo, Suspense, useMemo } from 'react';
import { DelayedRender } from '@librechat/client';
import { Constants, parseThinkingContent } from 'librechat-data-provider';
import {
  Thinking,
  ErrorBox,
  Container,
  ErrorMessage,
  CollapsibleText,
  ToolCallLimitNotice,
} from '@librechat/chat/components';
import type { TMessage } from 'librechat-data-provider';
import type { TMessageContentProps, TDisplayProps } from '~/common';
import { useMessagePartsHost } from '~/Providers/MessagePartsHostContext';
import useSmoothStreaming from '~/hooks/Messages/useSmoothStreaming';
/** Registers the key dialog and recovery actions an error draws through the host. */
import '~/components/Messages/Content/Error/register';
import { useLocalize } from '~/hooks';
import MarkdownLite from './MarkdownLite';
import EditMessage from './EditMessage';
import Markdown from './Markdown';
import { cn } from '~/utils';

const UNFINISHED_DELAY = 250;

export { ErrorMessage };

export const DisplayMessage = ({ text, isCreatedByUser, message, showCursor }: TDisplayProps) => {
  const { useMessage, useUserTextPreferences } = useMessagePartsHost();
  const { isSubmitting = false, isLatestMessage = false } = useMessage();
  const { enableUserMsgMarkdown, collapseLongUserMessages } = useUserTextPreferences();
  const smoothStreaming = useSmoothStreaming();

  // The word fade itself indicates streaming, so the trailing block cursor
  // only shows when the fade is unavailable (setting off or reduced motion).
  const showCursorState = useMemo(
    () => showCursor === true && isSubmitting && !(smoothStreaming && !isCreatedByUser),
    [showCursor, isSubmitting, smoothStreaming, isCreatedByUser],
  );

  const content = useMemo(() => {
    if (!isCreatedByUser) {
      return <Markdown content={text} isLatestMessage={isLatestMessage} />;
    }
    if (enableUserMsgMarkdown) {
      return <MarkdownLite content={text} />;
    }
    return <>{text}</>;
  }, [isCreatedByUser, enableUserMsgMarkdown, text, isLatestMessage]);

  return (
    <Container message={message}>
      <CollapsibleText enabled={isCreatedByUser && collapseLongUserMessages}>
        <div
          className={cn(
            'markdown prose message-content light w-full break-words',
            isSubmitting && 'submitting',
            showCursorState && text.length > 0 && 'result-streaming',
            isCreatedByUser && !enableUserMsgMarkdown && 'whitespace-pre-wrap',
            'text-text-primary',
          )}
        >
          {content}
        </div>
      </CollapsibleText>
    </Container>
  );
};

export const UnfinishedMessage = ({ message }: { message: TMessage }) => {
  const localize = useLocalize();

  /** Ran out of steps, not broken: a distinct, actionable card rather than the
   *  generic "something went wrong, try again" warning. */
  if (message.finish_reason === Constants.TOOL_CALL_LIMIT_FINISH_REASON) {
    return (
      <Container message={message}>
        <ToolCallLimitNotice message={message} />
      </Container>
    );
  }

  /**
   * Copy this app authored, not a persisted failure: it goes straight into the error box. Routing
   * it through `Error` would have the unclassified-text path treat the sentence as provider prose
   * and headline it with "<provider> could not complete this request".
   */
  return (
    <Container message={message}>
      <ErrorBox>{localize('com_ui_response_incomplete')}</ErrorBox>
    </Container>
  );
};

const MessageContent = ({
  text,
  edit,
  error,
  unfinished,
  isSubmitting,
  isLast,
  ...props
}: TMessageContentProps) => {
  const { message } = props;
  const { messageId } = message;

  const { thinkingContent, regularContent } = useMemo(() => parseThinkingContent(text), [text]);
  const showRegularCursor = useMemo(() => isLast && isSubmitting, [isLast, isSubmitting]);

  const unfinishedMessage = useMemo(
    () =>
      !isSubmitting && unfinished ? (
        <Suspense>
          <DelayedRender delay={UNFINISHED_DELAY}>
            <UnfinishedMessage message={message} />
          </DelayedRender>
        </Suspense>
      ) : null,
    [isSubmitting, unfinished, message],
  );

  if (error) {
    return <ErrorMessage message={message} text={text} />;
  }

  if (edit) {
    return <EditMessage text={text} isSubmitting={isSubmitting} {...props} />;
  }

  return (
    <>
      {thinkingContent.length > 0 && (
        <Thinking key={`thinking-${messageId}`}>{thinkingContent}</Thinking>
      )}
      <DisplayMessage
        key={`display-${messageId}`}
        showCursor={showRegularCursor}
        text={regularContent}
        {...props}
      />
      {unfinishedMessage}
    </>
  );
};

const MemoizedMessageContent = memo(MessageContent);
MemoizedMessageContent.displayName = 'MessageContent';

export default MemoizedMessageContent;
