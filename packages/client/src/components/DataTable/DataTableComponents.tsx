import React, { memo, forwardRef } from 'react';
import { JSX } from 'react/jsx-runtime';
import { flexRender } from '@tanstack/react-table';
import type { Row } from '@tanstack/react-table';
import type { TableColumn } from './DataTable.types';
import { TableCell, TableRow, TableRowHeader } from '../Table';
import { Checkbox } from '../Checkbox';
import { Skeleton } from '../Skeleton';
import { cn } from '~/utils';

export const SelectionCheckbox: React.MemoExoticComponent<
  ({
    checked,
    onChange,
    ariaLabel,
  }: {
    checked: boolean;
    onChange: (value: boolean) => void;
    ariaLabel: string;
  }) => JSX.Element
> = memo(
  ({
    checked,
    onChange,
    ariaLabel,
  }: {
    checked: boolean;
    onChange: (value: boolean) => void;
    ariaLabel: string;
  }): JSX.Element => (
    <div
      className="flex h-full w-8 items-center justify-center"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Checkbox checked={checked} onCheckedChange={onChange} aria-label={ariaLabel} />
    </div>
  ),
);

SelectionCheckbox.displayName = 'SelectionCheckbox';

interface TableRowComponentProps<TData extends Record<string, unknown>> {
  row: Row<TData>;
  virtualIndex?: number;
  style?: React.CSSProperties;
  selected: boolean;
}

// ...existing code...
const TableRowComponent = <TData extends Record<string, unknown>>(
  { row, virtualIndex, style, selected }: TableRowComponentProps<TData>,
  ref: React.Ref<HTMLTableRowElement>,
) => {
  return (
    <TableRow
      ref={ref}
      data-state={selected ? 'selected' : undefined}
      data-index={virtualIndex}
      /* The highlight is painted by the cells, not the row: `border-radius` has no
         effect on a table row, so rounding the outer cells is what gives the hover
         its pill shape. */
      className="group border-0 hover:bg-transparent [&>*:first-child]:rounded-l-lg [&>*:last-child]:rounded-r-lg"
      style={style}
    >
      {row.getVisibleCells().map((cell) => {
        const meta = cell.column.columnDef.meta as
          | { className?: string; desktopOnly?: boolean; width?: number; isRowHeader?: boolean }
          | undefined;
        const isDesktopOnly = meta?.desktopOnly;
        const isRowHeader = meta?.isRowHeader;
        const percent = meta?.width;
        let widthStyle: React.CSSProperties | undefined;
        if (cell.column.id === 'select') {
          widthStyle = { width: '2rem', maxWidth: '2rem', minWidth: '2rem' };
        } else if (percent) {
          widthStyle = {
            width: `${percent}%`,
            maxWidth: `${percent}%`,
            minWidth: `${percent}%`, // Don't shrink on mobile
          };
        }

        const CellComponent = isRowHeader ? TableRowHeader : TableCell;

        return (
          <CellComponent
            key={cell.id}
            size="dense"
            className={cn(
              'max-w-0 truncate px-3 text-sm transition-colors',
              'group-hover:bg-surface-secondary-alt group-data-[state=selected]:bg-surface-active',
              cell.column.id === 'select' && 'w-8 p-1',
              meta?.className,
              isDesktopOnly && '[display:var(--data-table-desktop-display,table-cell)]',
            )}
            style={widthStyle}
          >
            {flexRender(cell.column.columnDef.cell, cell.getContext())}
          </CellComponent>
        );
      })}
    </TableRow>
  );
};
// ...existing code...

type ForwardTableRowComponentType = <TData extends Record<string, unknown>>(
  props: TableRowComponentProps<TData> & React.RefAttributes<HTMLTableRowElement>,
) => JSX.Element;

const ForwardTableRowComponent = forwardRef(TableRowComponent) as ForwardTableRowComponentType;

interface GenericRowProps {
  row: Row<Record<string, unknown>>;
  virtualIndex?: number;
  style?: React.CSSProperties;
  selected: boolean;
  /** Bumped when the column definitions change. Row data alone can't express a cell
   *  that renders external state (a pending row action, say), so without this the
   *  memo would keep showing the stale cell until the underlying row object moves. */
  cellsVersion?: number;
}

export const MemoizedTableRow: React.MemoExoticComponent<(props: GenericRowProps) => JSX.Element> =
  memo(
    ForwardTableRowComponent as (props: GenericRowProps) => JSX.Element,
    (prev: GenericRowProps, next: GenericRowProps) =>
      prev.row.original === next.row.original &&
      prev.selected === next.selected &&
      prev.cellsVersion === next.cellsVersion &&
      /** The row height follows the theme, so a theme switch has to reach mounted rows. */
      prev.style?.height === next.style?.height,
  );

export const SkeletonRows: React.MemoExoticComponent<
  <TData extends Record<string, unknown>, TValue>({
    count,
    columns,
    rowHeight,
  }: {
    count?: number;
    columns: TableColumn<TData, TValue>[];
    rowHeight?: number;
  }) => JSX.Element
> = memo(
  <TData extends Record<string, unknown>, TValue>({
    count = 10,
    columns,
    rowHeight = 40,
  }: {
    count?: number;
    columns: TableColumn<TData, TValue>[];
    rowHeight?: number;
  }): JSX.Element => (
    <>
      {Array.from({ length: count }, (_, index) => (
        <TableRow
          key={`skeleton-${index}`}
          className="border-0 hover:bg-transparent"
          style={{ height: rowHeight }}
        >
          {columns.map((column) => {
            const columnKey = String(
              column.id ?? ('accessorKey' in column && column.accessorKey) ?? '',
            );
            const meta = column.meta as { className?: string; desktopOnly?: boolean } | undefined;
            return (
              <TableCell
                key={columnKey}
                size="dense"
                className={cn(
                  'px-3',
                  meta?.className,
                  meta?.desktopOnly && '[display:var(--data-table-desktop-display,table-cell)]',
                )}
              >
                <Skeleton className="h-6 w-full" />
              </TableCell>
            );
          })}
        </TableRow>
      ))}
    </>
  ),
);

SkeletonRows.displayName = 'SkeletonRows';
