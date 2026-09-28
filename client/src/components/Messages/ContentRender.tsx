import { useCallback, useMemo, memo } from 'react';
import { useAtomValue } from 'jotai';
import { useRecoilValue } from 'recoil';
import { Constants } from 'librechat-data-provider';
import type { TMessage, TMessageContentParts } from 'librechat-data-provider';
import type { TMessageProps, TMessageIcon, TMessageChatContext } from '~/common';
import {
  areMessageFieldsEqual,
  cn,
  getHeaderPrefixForScreenReader,
  getMessageAriaLabel,
} from '~/utils';
import { revealOnRowHoverClasses, messageFooterClasses } from '~/components/Chat/Messages/styles';
import { useLocalize, useAttachments, useMessageActions, useContentMetadata } from '~/hooks';
import ResumeAuthorHeader from '~/components/Chat/Messages/Content/Parts/ResumeAuthorHeader';
import ToolCallLimitNotice from '~/components/Chat/Messages/Content/ToolCallLimitNotice';
import { ErrorSourceProvider } from '~/components/Messages/Content/Error/source';
import Elapsed, { shouldShowElapsed } from '~/components/Chat/Messages/Elapsed';
import { getHeaderHoverLabel } from '~/components/Chat/Messages/ui/HeaderLabel';
import ContentParts from '~/components/Chat/Messages/Content/ContentParts';
import SiblingSwitch from '~/components/Chat/Messages/SiblingSwitch';
import HoverButtons from '~/components/Chat/Messages/HoverButtons';
import MessageRow from '~/components/Chat/Messages/ui/MessageRow';
import MessageIcon from '~/components/Chat/Messages/MessageIcon';
import { showThinkingAtom } from '~/store/showThinking';
import SubRow from '~/components/Chat/Messages/SubRow';
import { AuthorContext } from '~/Providers';
import store from '~/store';

/**
 * The one header every assistant message hands its parts. It reads the author from
 * `AuthorContext`, so the author resolving after paint cannot break the parts' memo.
 */
const RESUME_AUTHOR_HEADER = <ResumeAuthorHeader />;

type ContentRenderProps = {
  message?: TMessage;
  /**
   * Effective isSubmitting: false for non-latest messages, real value for latest.
   * Computed by the wrapper (MessageContent.tsx) so this memo'd component only re-renders
   * when the value actually matters.
   */
  isSubmitting?: boolean;
  /** Stable context object from wrapper — avoids ChatContext subscription inside memo */
  chatContext: TMessageChatContext;
} & Pick<
  TMessageProps,
  'currentEditId' | 'setCurrentEditId' | 'siblingIdx' | 'setSiblingIdx' | 'siblingCount'
>;

/**
 * Custom comparator for React.memo: compares `message` by key fields instead of reference
 * because `buildTree` creates new message objects on every streaming update for ALL messages.
 */
function areContentRenderPropsEqual(prev: ContentRenderProps, next: ContentRenderProps): boolean {
  if (prev.isSubmitting !== next.isSubmitting) {
    return false;
  }
  if (prev.chatContext !== next.chatContext) {
    return false;
  }
  if (prev.siblingIdx !== next.siblingIdx) {
    return false;
  }
  if (prev.siblingCount !== next.siblingCount) {
    return false;
  }
  if (prev.currentEditId !== next.currentEditId) {
    return false;
  }
  if (prev.setSiblingIdx !== next.setSiblingIdx) {
    return false;
  }
  if (prev.setCurrentEditId !== next.setCurrentEditId) {
    return false;
  }

  return areMessageFieldsEqual(prev.message, next.message);
}

const ContentRender = memo(function ContentRender({
  message: msg,
  siblingIdx,
  siblingCount,
  setSiblingIdx,
  currentEditId,
  setCurrentEditId,
  isSubmitting = false,
  chatContext,
}: ContentRenderProps) {
  const localize = useLocalize();
  const { attachments, searchResults } = useAttachments({
    messageId: msg?.messageId,
    attachments: msg?.attachments,
  });
  const {
    edit,
    index,
    agent,
    assistant,
    enterEdit,
    conversation,
    messageLabel,
    handleContinue,
    handleFeedback,
    latestMessageId,
    copyToClipboard,
    getCanCopy,
    regenerateMessage,
    latestMessageDepth,
    hasConfiguredSender,
  } = useMessageActions({
    message: msg,
    searchResults,
    currentEditId,
    setCurrentEditId,
    chatContext,
  });
  const maximizeChatSpace = useRecoilValue(store.maximizeChatSpace);
  const autoExpandTools = useRecoilValue(store.autoExpandTools);
  const showThinking = useAtomValue(showThinkingAtom);

  const handleRegenerateMessage = useCallback(() => regenerateMessage(), [regenerateMessage]);
  const isLast = useMemo(
    () => !(msg?.children?.length ?? 0) && (msg?.depth === latestMessageDepth || msg?.depth === -1),
    [msg?.children, msg?.depth, latestMessageDepth],
  );
  const isLatestMessage = msg?.messageId === latestMessageId;

  const iconData: TMessageIcon = useMemo(
    () => ({
      endpoint: msg?.endpoint ?? conversation?.endpoint,
      model: msg?.model ?? conversation?.model,
      iconURL: msg?.iconURL,
      modelLabel: messageLabel,
      isCreatedByUser: msg?.isCreatedByUser,
    }),
    [
      messageLabel,
      conversation?.endpoint,
      conversation?.model,
      msg?.model,
      msg?.iconURL,
      msg?.endpoint,
      msg?.isCreatedByUser,
    ],
  );

  const author = useMemo(
    () => ({
      icon: <MessageIcon iconData={iconData} assistant={assistant} agent={agent} />,
      label: messageLabel ?? '',
    }),
    [iconData, assistant, agent, messageLabel],
  );

  const { hasParallelContent } = useContentMetadata(msg);

  if (!msg) {
    return null;
  }

  return (
    <MessageRow
      id={msg.messageId}
      icon={author.icon}
      label={author.label}
      hoverLabel={getHeaderHoverLabel(
        hasConfiguredSender,
        agent?.model,
        assistant?.model,
        msg.model,
        conversation?.model,
      )}
      timestamp={msg.createdAt ?? msg.clientTimestamp}
      ariaLabel={getMessageAriaLabel(msg, localize)}
      headerPrefix={getHeaderPrefixForScreenReader(msg, localize)}
      isCreatedByUser={msg.isCreatedByUser === true}
      hasParallelContent={hasParallelContent}
      fullWidth={maximizeChatSpace}
      isEditing={edit}
      footer={
        <SubRow classes={cn(messageFooterClasses, msg.isCreatedByUser && 'justify-end')}>
          {/* The reading holds the column start: it takes over the slot the streaming
              dot vacates, so the retry navigation beside it — whose width the footer
              reserves whether or not hover has revealed it — must never push the
              timer inboard of that column. */}
          {shouldShowElapsed({
            isSubmitting,
            isLatestMessage,
            isCreatedByUser: msg.isCreatedByUser,
            siblingIdx,
            siblingCount,
          }) && <Elapsed index={index} />}
          {/* While the answer is generating every other action is withheld, which
              would otherwise leave this counter sitting alone under a half-written
              response. It reveals on hover there, like the actions it sits with. */}
          <SiblingSwitch
            siblingIdx={siblingIdx}
            siblingCount={siblingCount}
            setSiblingIdx={setSiblingIdx}
            className={cn(isSubmitting && isLatestMessage && revealOnRowHoverClasses)}
          />
          <HoverButtons
            index={index}
            message={msg}
            isEditing={edit}
            enterEdit={enterEdit}
            isSubmitting={chatContext.isSubmitting}
            conversation={conversation ?? null}
            regenerate={handleRegenerateMessage}
            copyToClipboard={copyToClipboard}
            getCanCopy={getCanCopy}
            handleContinue={handleContinue}
            latestMessageId={latestMessageId}
            handleFeedback={handleFeedback}
            isLast={isLast}
          />
        </SubRow>
      }
    >
      <AuthorContext.Provider value={author}>
        <ErrorSourceProvider message={msg}>
          <ContentParts
            edit={edit}
            isLast={isLast}
            enterEdit={enterEdit}
            siblingIdx={siblingIdx}
            messageId={msg.messageId}
            attachments={attachments}
            searchResults={searchResults}
            manualSkills={msg.manualSkills}
            authorHeader={msg.isCreatedByUser === true ? undefined : RESUME_AUTHOR_HEADER}
            setSiblingIdx={setSiblingIdx}
            isLatestMessage={isLatestMessage}
            isSubmitting={isSubmitting}
            isCreatedByUser={msg.isCreatedByUser}
            createdAt={msg.createdAt ?? msg.clientTimestamp}
            foldLiveActivity={!autoExpandTools}
            showThinking={showThinking}
            conversationId={conversation?.conversationId}
            content={msg.content as Array<TMessageContentParts | undefined>}
          />
        </ErrorSourceProvider>
      </AuthorContext.Provider>
      {/** A turn that ran out of agent steps is incomplete, not broken. Rendered
       *   here rather than inside `ContentParts` because it is a message-level
       *   outcome, and `ContentParts` also serves surfaces (subagent panels,
       *   search) that have no message row behind them. */}
      {msg.unfinished === true &&
        !isSubmitting &&
        msg.finish_reason === Constants.TOOL_CALL_LIMIT_FINISH_REASON && (
          <ToolCallLimitNotice message={msg} />
        )}
    </MessageRow>
  );
}, areContentRenderPropsEqual);
ContentRender.displayName = 'ContentRender';

export default ContentRender;
