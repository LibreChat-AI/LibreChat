import { useCallback, useEffect, useMemo, useRef } from 'react';
import * as Ariakit from '@ariakit/react';
import { AutoSizer, List } from 'react-virtualized';
import type { ListRowProps } from 'react-virtualized';
import type { Endpoint } from '~/common';
import { EndpointModelItem } from './EndpointModelItem';

/** Matches the rendered height of a `CustomMenuItem` row (px-2 py-1 around a py-1 body). */
const ROW_HEIGHT = 36;
const MAX_LIST_HEIGHT = 320;
const OVERSCAN = 8;

interface VirtualizedModelListProps {
  endpoint: Endpoint;
  modelIds: string[];
  globalByName: Map<string, boolean>;
  isFavorite: (modelId: string) => boolean;
  onToggleFavorite: (modelId: string) => void;
  endpointIndex?: number;
  /** Count of options rendered ahead of this list in the same listbox. */
  precedingOptionCount: number;
  /** Total selectable options in the surrounding listbox, when known. */
  listboxSetSize?: number;
}

/**
 * Windowed model list for endpoints with very large model sets (agents, mainly).
 *
 * Only the visible slice is mounted, so the per-row costs — Ariakit composite
 * registration, the active-item subscription, and ~12 DOM nodes each — stay
 * bounded no matter how many agents the user can see.
 *
 * Ariakit's composite only knows about mounted rows, so arrow-keying to the edge
 * of the window would otherwise find no next item and let focus escape the nested
 * menu, closing it. `handleBoundaryNavigation` catches that case: it scrolls the
 * next index into the window, waits for the row to mount, then moves the composite
 * onto it. Navigation inside the window is left entirely to Ariakit, whose own
 * `scrollIntoView` drives the list's scroll position.
 */
export default function VirtualizedModelList({
  endpoint,
  modelIds,
  globalByName,
  isFavorite,
  onToggleFavorite,
  endpointIndex,
  precedingOptionCount,
  listboxSetSize,
}: VirtualizedModelListProps) {
  const listRef = useRef<List>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const combobox = Ariakit.useComboboxContext();
  const indexSuffix = endpointIndex != null ? `-${endpointIndex}` : '';
  const rowCount = modelIds.length;

  const rowAt = useCallback(
    (index: number) =>
      containerRef.current?.querySelector<HTMLElement>(
        `[data-row-index="${index}"] [role="option"], [data-row-index="${index}"] [role="menuitem"]`,
      ) ?? null,
    [],
  );

  useEffect(() => {
    if (!combobox) {
      return;
    }
    const deltaFor = (key: string) => {
      if (key === 'ArrowDown') {
        return 1;
      }
      return key === 'ArrowUp' ? -1 : 0;
    };
    const handleBoundaryNavigation = (event: KeyboardEvent) => {
      const delta = deltaFor(event.key);
      if (delta === 0 || !containerRef.current) {
        return;
      }
      const activeId = combobox.getState().activeId;
      const activeRow = activeId ? document.getElementById(activeId) : null;
      const wrapper = activeRow?.closest<HTMLElement>('[data-row-index]');
      let next: number | null = null;

      if (wrapper && containerRef.current.contains(wrapper)) {
        const currentIndex = Number(wrapper.dataset.rowIndex);
        const candidate = currentIndex + delta;
        /** Let Ariakit own both the in-window case and the ends of the list. */
        if (candidate < 0 || candidate >= rowCount || rowAt(candidate)) {
          return;
        }
        next = candidate;
      } else {
        const activePosition = Number(activeRow?.getAttribute('aria-posinset'));
        const entersFromBefore = delta === 1 && activePosition === precedingOptionCount;
        const entersFromAfter =
          delta === -1 && activePosition === precedingOptionCount + rowCount + 1;
        if (entersFromBefore) {
          next = 0;
        } else if (entersFromAfter) {
          next = rowCount - 1;
        } else {
          return;
        }
      }

      event.preventDefault();
      event.stopPropagation();
      listRef.current?.scrollToRow(next!);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const id = rowAt(next!)?.id;
          if (id) {
            combobox.move(id);
          }
        });
      });
    };
    document.addEventListener('keydown', handleBoundaryNavigation, true);
    return () => document.removeEventListener('keydown', handleBoundaryNavigation, true);
  }, [combobox, precedingOptionCount, rowCount, rowAt]);

  const height = useMemo(
    () => Math.min(MAX_LIST_HEIGHT, Math.max(ROW_HEIGHT, rowCount * ROW_HEIGHT)),
    [rowCount],
  );

  const rowRenderer = useCallback(
    ({ index, key, style }: ListRowProps) => {
      const modelId = modelIds[index];
      return (
        <div key={key} style={style} data-row-index={index}>
          <EndpointModelItem
            modelId={modelId}
            endpoint={endpoint}
            isGlobal={globalByName.get(modelId) ?? false}
            isFavorite={isFavorite(modelId)}
            onToggleFavorite={onToggleFavorite}
            posInSet={precedingOptionCount + index + 1}
            setSize={listboxSetSize ?? precedingOptionCount + rowCount}
          />
        </div>
      );
    },
    [
      globalByName,
      endpoint,
      isFavorite,
      listboxSetSize,
      modelIds,
      onToggleFavorite,
      precedingOptionCount,
      rowCount,
    ],
  );

  return (
    <div
      ref={containerRef}
      data-endpoint-models={`${endpoint.value}${indexSuffix}`}
      className="w-full"
    >
      <AutoSizer disableHeight>
        {({ width }) => (
          <List
            ref={listRef}
            width={width}
            height={height}
            rowCount={rowCount}
            rowHeight={ROW_HEIGHT}
            overscanRowCount={OVERSCAN}
            rowRenderer={rowRenderer}
            className="outline-hidden!"
            /**
             * `List` spreads its props onto the underlying `Grid`, whose defaults are
             * `role="grid"`, `containerRole="row"` and `tabIndex={0}`. Left alone, that puts a
             * focusable grid between Ariakit's listbox and its options: tabbing out of the
             * search field lands on the wrapper instead of a row, where the combobox no longer
             * owns the keystroke, and the grid/row semantics fight the surrounding listbox.
             * Neutralise both so focus and ARIA stay with the combobox items.
             */
            role="presentation"
            containerRole="presentation"
            tabIndex={-1}
          />
        )}
      </AutoSizer>
    </div>
  );
}
