import React, { useMemo } from 'react';
import { useRecoilValue } from 'recoil';
import { ContentRow, HoverButtons } from '@librechat/chat/components';
import type { TMessageProps, TMessageIcon } from '~/common';
import ResumeAuthorHeader from '~/components/Chat/Messages/Content/Parts/ResumeAuthorHeader';
import { useLocalize, useAttachments, useMessageHelpers, useContentMetadata } from '~/hooks';
import { areMessageRowPropsEqual } from '~/utils';
import store from '~/store';

/**
 * The one header every assistant message hands its parts. It reads the author from
 * `AuthorContext`, so the author resolving after paint cannot break the parts' memo.
 */
const RESUME_AUTHOR_HEADER = <ResumeAuthorHeader />;

function MessageParts(props: TMessageProps) {
  const localize = useLocalize();
  const { message, siblingIdx, siblingCount, setSiblingIdx } = props;
  const { attachments, searchResults } = useAttachments({
    messageId: message?.messageId,
    attachments: message?.attachments,
  });
  const {
    edit,
    index,
    agent,
    isLast,
    enterEdit,
    assistant,
    handleScroll,
    conversation,
    isSubmitting,
    latestMessageId,
    handleContinue,
    copyToClipboard,
    getCanCopy,
    regenerateMessage,
    hasConfiguredSender,
  } = useMessageHelpers(props, searchResults);

  const maximizeChatSpace = useRecoilValue(store.maximizeChatSpace);
  const { messageId = null, isCreatedByUser } = message ?? {};

  const name = useMemo(() => {
    let result = '';
    if (isCreatedByUser === true) {
      result = localize('com_user_message');
    } else if (assistant) {
      result = assistant.name ?? localize('com_ui_assistant');
    } else if (agent) {
      result = agent.name ?? localize('com_ui_agent');
    }

    return result;
  }, [assistant, agent, isCreatedByUser, localize]);

  const iconData: TMessageIcon = useMemo(
    () => ({
      endpoint: message?.endpoint ?? conversation?.endpoint,
      model: message?.model ?? conversation?.model,
      iconURL: message?.iconURL ?? conversation?.iconURL,
      modelLabel: name,
      isCreatedByUser: message?.isCreatedByUser,
    }),
    [
      name,
      conversation?.endpoint,
      conversation?.iconURL,
      conversation?.model,
      message?.model,
      message?.iconURL,
      message?.endpoint,
      message?.isCreatedByUser,
    ],
  );

  const { hasParallelContent } = useContentMetadata(message);

  if (!message) {
    return null;
  }

  return (
    <div
      className="w-full border-0 bg-transparent"
      onWheel={handleScroll}
      onTouchMove={handleScroll}
    >
      <div className="m-auto justify-center px-4 py-3 sm:px-0">
        <ContentRow
          message={message}
          conversation={conversation ?? null}
          index={index}
          label={name}
          iconData={iconData}
          agent={agent}
          assistant={assistant}
          hasConfiguredSender={hasConfiguredSender}
          isLast={isLast}
          isLatestMessage={messageId === latestMessageId}
          isSubmitting={isSubmitting}
          edit={edit}
          enterEdit={enterEdit}
          siblingIdx={siblingIdx}
          siblingCount={siblingCount}
          setSiblingIdx={setSiblingIdx}
          attachments={attachments}
          searchResults={searchResults}
          hasParallelContent={hasParallelContent}
          fullWidth={maximizeChatSpace}
          toolbar={
            <HoverButtons
              index={index}
              isEditing={edit}
              message={message}
              enterEdit={enterEdit}
              conversation={conversation ?? null}
              regenerate={() => regenerateMessage()}
              copyToClipboard={copyToClipboard}
              getCanCopy={getCanCopy}
              handleContinue={handleContinue}
              latestMessageId={latestMessageId}
              isLast={isLast}
            />
          }
          authorHeader={RESUME_AUTHOR_HEADER}
          renderOwnerId={message.clientQueueParentMessageId}
        />
      </div>
    </div>
  );
}

export default React.memo(MessageParts, areMessageRowPropsEqual);
