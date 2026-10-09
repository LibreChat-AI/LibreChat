import { useMemo } from 'react';
import type { TMessageProps } from '~/common';
import SearchContent, {
  rendersMarkdownLite,
} from '~/components/Chat/Messages/Content/SearchContent';
import { parseWakeupMessage } from '~/components/Chat/Messages/Content/Parts/wakeup';
import AuthorHeader from '~/components/Chat/Messages/Content/Parts/AuthorHeader';
import MinimalHoverButtons from '~/components/Chat/Messages/MinimalHoverButtons';
import { getHeaderHoverLabel } from '~/components/Chat/Messages/ui/HeaderLabel';
import MessageContent from '~/components/Chat/Messages/Content/MessageContent';
import { getHeaderPrefixForScreenReader, getMessageAriaLabel } from '~/utils';
import SiblingSwitch from '~/components/Chat/Messages/SiblingSwitch';
import MessageRow from '~/components/Chat/Messages/ui/MessageRow';
import WakeupRow from '~/components/Chat/Messages/ui/WakeupRow';
import Wakeup from '~/components/Chat/Messages/Content/Wakeup';
import { MessageContext, useShareContext } from '~/Providers';
import SubRow from '~/components/Chat/Messages/SubRow';
import { useAttachments, useLocalize } from '~/hooks';
import MultiMessage from './MultiMessage';
import Icon from './MessageIcon';

export default function Message(props: TMessageProps) {
  const localize = useLocalize();
  const { hasConfiguredSender } = useShareContext();
  const {
    message,
    siblingIdx,
    siblingCount,
    conversation,
    setSiblingIdx,
    currentEditId,
    setCurrentEditId,
  } = props;

  const { attachments, searchResults } = useAttachments({
    messageId: message?.messageId,
    attachments: message?.attachments,
  });
  const wakeupDisplay = useMemo(() => parseWakeupMessage(message), [message]);

  if (!message) {
    return null;
  }

  const {
    text = '',
    children,
    error = false,
    messageId = '',
    unfinished = false,
    isCreatedByUser = true,
  } = message;

  /** Whoever opens a share link is not the author of the prompts in it, so this row
   *  keeps a neutral label. `com_user_message` reads "You", which is right in the chat
   *  view and wrong here: it is the screen-reader heading for the user turn, and it
   *  would credit every prompt the sharer wrote to the person reading the transcript. */
  const messageLabel = isCreatedByUser ? localize('com_ui_user') : (message.sender ?? '');
  const subagentWakeup = wakeupDisplay?.kind === 'subagent' ? wakeupDisplay.tasks[0] : undefined;
  const Row = subagentWakeup == null ? MessageRow : WakeupRow;

  return (
    <>
      <div className="text-text-primary w-full border-0 bg-transparent">
        <div className="m-auto justify-center px-4 py-3 sm:px-0">
          <Row
            task={subagentWakeup}
            conversationId={message.conversationId ?? conversation?.conversationId ?? ''}
            id={messageId}
            icon={<Icon message={message} conversation={conversation} />}
            label={messageLabel}
            hoverLabel={getHeaderHoverLabel(hasConfiguredSender, message.model)}
            timestamp={message.createdAt ?? message.clientTimestamp}
            ariaLabel={getMessageAriaLabel(message, localize)}
            headerPrefix={getHeaderPrefixForScreenReader(message, localize)}
            isCreatedByUser={isCreatedByUser}
            systemLabel={
              wakeupDisplay != null && subagentWakeup == null
                ? localize('com_ui_system_event')
                : undefined
            }
            className="final-completion"
            footer={
              <SubRow classes={isCreatedByUser ? 'justify-end text-xs' : 'text-xs'}>
                <SiblingSwitch
                  siblingIdx={siblingIdx}
                  siblingCount={siblingCount}
                  setSiblingIdx={setSiblingIdx}
                />
                <MinimalHoverButtons
                  message={message}
                  searchResults={searchResults}
                  variant={message.content && rendersMarkdownLite(message) ? 'lite' : undefined}
                />
              </SubRow>
            }
          >
            <MessageContext.Provider
              value={{
                messageId,
                isExpanded: false,
                conversationId: conversation?.conversationId,
                isSubmitting: false,
                isLatestMessage: false,
              }}
            >
              {wakeupDisplay != null && (
                <Wakeup display={wakeupDisplay} conversationId={message.conversationId} />
              )}
              {wakeupDisplay == null &&
                (message.content ? (
                  <SearchContent
                    message={message}
                    attachments={attachments}
                    searchResults={searchResults}
                    authorHeader={
                      isCreatedByUser ? undefined : (
                        <AuthorHeader
                          icon={<Icon message={message} conversation={conversation} />}
                          label={messageLabel}
                        />
                      )
                    }
                  />
                ) : (
                  <MessageContent
                    edit={false}
                    error={error}
                    isLast={false}
                    ask={() => {}}
                    text={text || ''}
                    message={message}
                    isSubmitting={false}
                    enterEdit={() => ({})}
                    unfinished={unfinished}
                    siblingIdx={siblingIdx ?? 0}
                    isCreatedByUser={isCreatedByUser}
                    setSiblingIdx={setSiblingIdx ?? (() => ({}))}
                  />
                ))}
            </MessageContext.Provider>
          </Row>
        </div>
      </div>
      <MultiMessage
        key={messageId}
        messageId={messageId}
        messagesTree={children ?? []}
        currentEditId={currentEditId}
        setCurrentEditId={setCurrentEditId}
      />
    </>
  );
}
