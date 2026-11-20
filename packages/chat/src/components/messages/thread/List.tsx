import { memo } from 'react';
import type { NamedExoticComponent, ReactElement } from 'react';
import type { ThreadMessageProps } from '../../../react/messages/types';
import type { ThreadRow } from '../../../core/thread';
import { RowGate } from '../../../react/messages/useProgressiveRowMount';
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
  return (
    <>
      {rows.map((row) => (
        <RowGate key={row.depth} depth={row.depth}>
          <Row row={row} currentEditId={currentEditId} setCurrentEditId={setCurrentEditId} />
        </RowGate>
      ))}
    </>
  );
}

const MemoizedList: NamedExoticComponent<ListProps> = memo(List);

export default MemoizedList;
