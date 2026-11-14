import { AutoSizer, List } from 'react-virtualized';
import type { PaletteListHandle, PaletteListProps } from '@librechat/chat/react';

/** The windowed list is a class component. The palette only needs its row-cache reset, so the
 *  instance is stored as that handle rather than as the list's own type. */
function setListHandle(listRef: PaletteListProps['listRef'], list: PaletteListHandle | null): void {
  if (typeof listRef === 'function') {
    listRef(list);
    return;
  }
  if (listRef != null) {
    (listRef as { current: PaletteListHandle | null }).current = list;
  }
}

/**
 * Windows the composer palette's rows. The grid roles stay on the scroller itself: a wrapper
 * between the grid and its rows always exposes `aria-label` and `aria-readonly`, which only a
 * grid may carry.
 */
export default function PaletteList({
  listRef,
  rowCount,
  rowHeight,
  rowRenderer,
  height,
  scrollToIndex,
  id,
  ariaLabel,
  className,
}: PaletteListProps) {
  return (
    <AutoSizer disableHeight>
      {({ width }) => (
        <List
          ref={(list) => {
            setListHandle(listRef, list);
          }}
          width={width}
          overscanRowCount={8}
          rowCount={rowCount}
          id={id}
          role="grid"
          aria-label={ariaLabel}
          containerRole="rowgroup"
          containerProps={{ 'aria-rowcount': rowCount }}
          tabIndex={-1}
          scrollToIndex={scrollToIndex}
          rowRenderer={rowRenderer}
          rowHeight={rowHeight}
          height={height}
          className={className}
        />
      )}
    </AutoSizer>
  );
}
