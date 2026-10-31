import { memo, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import { siblingIdxFamily, useMessagesHost } from '@librechat/chat/react';
import { activityParentMessageIds, hasParallelLanes } from '@librechat/chat';
import type { MessageRowSlotProps } from '@librechat/chat/react';
import type { ThreadRow } from '@librechat/chat';

type RowProps = Pick<MessageRowSlotProps, 'currentEditId' | 'setCurrentEditId'> & {
  row: ThreadRow;
};

/** One visible row of the flat thread: the message plus its activity group. */
function Row({ row, currentEditId, setCurrentEditId }: RowProps) {
  const { renderMessageRow, renderActivity } = useMessagesHost();
  const { message, siblingIdx, siblingCount, parentKey } = row;
  const setSiblingIdx = useSetAtom(siblingIdxFamily(parentKey));
  const setSiblingIdxRev = useCallback(
    (value: number) => {
      setSiblingIdx(siblingCount - value - 1);
    },
    [siblingCount, setSiblingIdx],
  );

  const activityIds = activityParentMessageIds(message, row.childCount > 0, currentEditId);
  const hasParallelContent = !message.isCreatedByUser && hasParallelLanes(message.content);

  return (
    <>
      {renderMessageRow({
        message,
        currentEditId,
        setCurrentEditId,
        siblingIdx: siblingCount - siblingIdx - 1,
        siblingCount,
        setSiblingIdx: setSiblingIdxRev,
      })}
      {activityIds.length > 0 ? (
        <div className="w-full border-0 bg-transparent">
          {renderActivity({
            conversationId: message.conversationId ?? '',
            parentMessageIds: activityIds,
            hasParallelContent,
          })}
        </div>
      ) : null}
    </>
  );
}

export default memo(Row);
