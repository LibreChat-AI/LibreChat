import { memo, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { isAssistantsEndpoint } from 'librechat-data-provider';
import type { ThreadRow } from '~/utils/thread';
import type { TMessageProps } from '~/common';
import EventSubagentActivityGroup from '~/components/Chat/Subagents/EventSubagentActivityGroup';
import MessageContent from '~/components/Messages/MessageContent';
import { hasParallelLanes } from '~/utils/lanes';
import MessageParts from '../MessageParts';
import { siblingIdxFamily } from './state';
import Message from '../Message';

type RowProps = {
  row: ThreadRow;
  currentEditId: TMessageProps['currentEditId'];
  setCurrentEditId: TMessageProps['setCurrentEditId'];
};

/** One visible row of the flat thread: the message plus its activity group. */
function Row({ row, currentEditId, setCurrentEditId }: RowProps) {
  const { message, siblingIdx, siblingCount, parentKey } = row;
  const setSiblingIdx = useSetAtom(siblingIdxFamily(parentKey));
  const setSiblingIdxRev = useCallback(
    (value: number) => {
      setSiblingIdx(siblingCount - value - 1);
    },
    [siblingCount, setSiblingIdx],
  );

  const sharedProps = {
    message,
    currentEditId,
    setCurrentEditId,
    siblingIdx: siblingCount - siblingIdx - 1,
    siblingCount,
    setSiblingIdx: setSiblingIdxRev,
  };

  let content: JSX.Element;
  if (isAssistantsEndpoint(message.endpoint) && message.content) {
    content = <MessageParts {...sharedProps} />;
  } else if (message.content) {
    content = <MessageContent {...sharedProps} />;
  } else {
    content = <Message {...sharedProps} />;
  }

  let activityParentMessageIds: string[] = [];
  if (message.isCreatedByUser) {
    if (row.childCount === 0) activityParentMessageIds = [message.messageId];
  } else {
    activityParentMessageIds = [message.messageId, message.parentMessageId].filter(
      (id): id is string => typeof id === 'string' && id.length > 0,
    );
  }
  const isEditingActivityAnchor =
    typeof currentEditId === 'string' && activityParentMessageIds.includes(currentEditId);
  const hasParallelContent = !message.isCreatedByUser && hasParallelLanes(message.content);

  return (
    <>
      {content}
      {!isEditingActivityAnchor && activityParentMessageIds.length > 0 ? (
        <div className="w-full border-0 bg-transparent">
          <EventSubagentActivityGroup
            conversationId={message.conversationId ?? ''}
            parentMessageIds={activityParentMessageIds}
            hasParallelContent={hasParallelContent}
          />
        </div>
      ) : null}
    </>
  );
}

export default memo(Row);
