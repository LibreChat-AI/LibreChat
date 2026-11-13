import { memo } from 'react';
import type { NamedExoticComponent, ReactElement } from 'react';
import type { ThreadMessageProps } from '../../../react/messages/types';
import type { ThreadRow } from '../../../core/thread';
import { useRowMountWindow } from '../../../react/messages/useProgressiveRowMount';
import Row from './Row';

type ListProps = Pick<ThreadMessageProps, 'currentEditId' | 'setCurrentEditId'> & {
  rows: ThreadRow[];
};

/**
 * Flat thread renderer. Rows are keyed by position, exactly the reconciliation
 * the recursive renderer relied on: message ids change across the streaming
 * lifecycle, while a row's position does not, so the streaming row keeps its
 * component instance and a sibling switch reuses the instances below it.
 */
function List({ rows, currentEditId, setCurrentEditId }: ListProps): ReactElement {
  const mountWindow = useRowMountWindow();
  return (
    <>
      {rows.map((row) =>
        mountWindow == null || (row.depth >= mountWindow.start && row.depth <= mountWindow.end) ? (
          <Row
            key={row.depth}
            row={row}
            currentEditId={currentEditId}
            setCurrentEditId={setCurrentEditId}
          />
        ) : null,
      )}
    </>
  );
}

const MemoizedList: NamedExoticComponent<ListProps> = memo(List);

export default MemoizedList;
