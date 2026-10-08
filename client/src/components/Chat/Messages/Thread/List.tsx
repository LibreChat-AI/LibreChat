import { memo } from 'react';
import type { ThreadRow } from '~/utils/thread';
import type { TMessageProps } from '~/common';
import { useRowMountWindow } from '~/hooks/Messages';
import Row from './Row';

type ListProps = {
  rows: ThreadRow[];
  currentEditId: TMessageProps['currentEditId'];
  setCurrentEditId: TMessageProps['setCurrentEditId'];
};

/**
 * Flat thread renderer. Rows are keyed by position, exactly the reconciliation
 * the recursive renderer relied on: message ids change across the streaming
 * lifecycle, while a row's position does not, so the streaming row keeps its
 * component instance and a sibling switch reuses the instances below it.
 */
function List({ rows, currentEditId, setCurrentEditId }: ListProps) {
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

export default memo(List);
