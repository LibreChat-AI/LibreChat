import { AutoSizer, List } from 'react-virtualized';
import type { CommandListProps } from '@librechat/chat/react';

/** Windows a command popover's rows; the popover's listbox owns the semantics, so the list's
 *  own grid roles step aside. */
export default function CommandList({
  count,
  activeIndex,
  rowHeight,
  height,
  renderRow,
}: CommandListProps) {
  return (
    <AutoSizer disableHeight>
      {({ width }) => (
        <List
          width={width}
          height={height}
          rowCount={count}
          rowHeight={rowHeight}
          overscanRowCount={5}
          rowRenderer={renderRow}
          scrollToIndex={activeIndex}
          role="presentation"
          containerRole="presentation"
        />
      )}
    </AutoSizer>
  );
}
