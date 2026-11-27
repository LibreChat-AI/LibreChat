import { memo, Suspense, useMemo } from 'react';
import { cn, useLocalize, DelayedRender } from '@librechat/client';
import { Constants, parseThinkingContent } from 'librechat-data-provider';
import type { NamedExoticComponent, ReactNode } from 'react';
import type { TMessage } from 'librechat-data-provider';
import type { MessageBodySlotProps } from '../../react/messages/host';
import { renderMarkdown as defaultRenderMarkdown } from '../renderers';
import ErrorMessage, { ErrorBox } from '../errors/ErrorMessage';
import ToolCallLimitNotice from '../parts/ToolCallLimitNotice';
import { useMessagesHost } from '../../react/messages/host';
import { useMessagePartsHost } from '../../react/host';
import CollapsibleText from '../CollapsibleText';
import Container from '../parts/Container';
import Thinking from '../parts/Thinking';

const UNFINISHED_DELAY = 250;

/** What `DisplayMessage` draws: a message's plain text. */
export type DisplayMessageProps = {
  text: string;
  message: TMessage;
  isCreatedByUser: boolean;
  /** Whether a cursor trails the text while it streams, where the word fade cannot show it. */
  showCursor?: boolean;
};

/**
 * A message's text, as the transcript shows it. A reply is markdown; a prompt is plain text that
 * keeps its line breaks, or markdown when the reader turned that on, and collapses when long if
 * the reader asked for that.
 */
export function DisplayMessage({
  text,
  message,
  showCursor,
  isCreatedByUser,
}: DisplayMessageProps): ReactNode {
  const host = useMessagePartsHost();
  const { renderMarkdown = defaultRenderMarkdown } = host;
  const { isSubmitting = false, isLatestMessage = false } = host.useMessage();
  const { enableUserMsgMarkdown, collapseLongUserMessages } = host.useUserTextPreferences();
  const smoothStreaming = host.useSmoothStreaming();

  /** The word fade itself shows a reply streaming, so the block cursor stands in only where the
   *  fade is off (the setting, or reduced motion). */
  const cursor = showCursor === true && isSubmitting && !(smoothStreaming && !isCreatedByUser);

  const content = useMemo(() => {
    if (!isCreatedByUser) {
      return renderMarkdown({ content: text, variant: 'full', isLatestMessage });
    }
    if (enableUserMsgMarkdown) {
      return renderMarkdown({ content: text, variant: 'lite', isLatestMessage });
    }
    return text;
  }, [renderMarkdown, isCreatedByUser, enableUserMsgMarkdown, text, isLatestMessage]);

  return (
    <Container message={message}>
      <CollapsibleText enabled={isCreatedByUser && collapseLongUserMessages}>
        <div
          className={cn(
            'markdown prose message-content light w-full break-words',
            isSubmitting && 'submitting',
            cursor && text.length > 0 && 'result-streaming',
            isCreatedByUser && !enableUserMsgMarkdown && 'whitespace-pre-wrap',
            'text-text-primary',
          )}
        >
          {content}
        </div>
      </CollapsibleText>
    </Container>
  );
}

/** The card for a reply that stopped before it finished. */
export function UnfinishedMessage({ message }: { message: TMessage }): ReactNode {
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
   * Copy this package authored, not a persisted failure: it goes straight into the error box.
   * Routing it through the error card would have the unclassified-text path treat the sentence as
   * provider prose and headline it with "<provider> could not complete this request".
   */
  return (
    <Container message={message}>
      <ErrorBox>{localize('com_ui_response_incomplete')}</ErrorBox>
    </Container>
  );
}

function Body({
  text,
  edit,
  error,
  unfinished,
  isSubmitting,
  isLast,
  ...props
}: MessageBodySlotProps): ReactNode {
  const { message, isCreatedByUser } = props;
  const { messageId } = message;
  const { renderMessageEditor } = useMessagesHost();

  const { thinkingContent, regularContent } = useMemo(() => parseThinkingContent(text), [text]);

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

  if (edit && renderMessageEditor != null) {
    return renderMessageEditor({ text, edit, error, unfinished, isSubmitting, isLast, ...props });
  }

  return (
    <>
      {thinkingContent.length > 0 && (
        <Thinking key={`thinking-${messageId}`}>{thinkingContent}</Thinking>
      )}
      <DisplayMessage
        key={`display-${messageId}`}
        showCursor={isLast && isSubmitting}
        text={regularContent}
        message={message}
        isCreatedByUser={isCreatedByUser}
      />
      {unfinishedMessage}
    </>
  );
}

/**
 * The body of a message with no content parts: every prompt, and a reply stored as plain text.
 * Its text, any thinking it carries, and a card when it failed or stopped early. A message being
 * edited draws the host's editor (`renderMessageEditor`), or reads as it is without one.
 */
export const MessageBody: NamedExoticComponent<MessageBodySlotProps> = memo(Body);
MessageBody.displayName = 'MessageBody';

/** How a row draws its body when the host names no renderer: `MessageBody`. */
export function renderMessageBody(props: MessageBodySlotProps): ReactNode {
  return <MessageBody {...props} />;
}
