import { memo, useCallback } from 'react';
import { useSetAtom } from 'jotai';
import type { NamedExoticComponent, ReactElement } from 'react';
import type { ThreadMessageProps } from '../../../react/messages/types';
import type { ThreadRow } from '../../../core/thread';
import { activityParentMessageIds } from '../../../core/activity';
import { useMessagesHost } from '../../../react/messages/host';
import { siblingIdxFamily } from '../../../react/thread';
import { hasParallelLanes } from '../../../core/lanes';
import ThreadMessage from './Message';

type RowProps = Pick<ThreadMessageProps, 'currentEditId' | 'setCurrentEditId'> & {
  row: ThreadRow;
};

/** One visible row of the flat thread: the message plus its activity group. */
function Row({ row, currentEditId, setCurrentEditId }: RowProps): ReactElement {
  const { renderActivity } = useMessagesHost();
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
      <ThreadMessage
        message={message}
        currentEditId={currentEditId}
        setCurrentEditId={setCurrentEditId}
        siblingIdx={siblingCount - siblingIdx - 1}
        siblingCount={siblingCount}
        setSiblingIdx={setSiblingIdxRev}
      />
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

const MemoizedRow: NamedExoticComponent<RowProps> = memo(Row);

export default MemoizedRow;
