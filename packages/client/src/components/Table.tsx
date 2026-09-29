import * as React from 'react';
import { cva } from 'class-variance-authority';
import { cn } from '~/utils';

interface TableProps extends React.HTMLAttributes<HTMLTableElement> {
  unwrapped?: boolean;
}

const Table: React.ForwardRefExoticComponent<TableProps & React.RefAttributes<HTMLTableElement>> =
  React.forwardRef<HTMLTableElement, TableProps>(
    ({ className, unwrapped = false, ...props }, ref) => {
      const tableElement = (
        <table ref={ref} className={cn('w-full caption-bottom text-sm', className)} {...props} />
      );

      if (unwrapped) {
        return tableElement;
      }

      return <div className="relative w-full overflow-auto">{tableElement}</div>;
    },
  );
Table.displayName = 'Table';

interface TableHeaderProps extends React.HTMLAttributes<HTMLTableSectionElement> {
  sticky?: boolean;
  /**
   * The header row's fill, on by default so column names read as a header in any theme. A table
   * whose header cells paint their own opaque fill turns it off, so a translucent cell state
   * (a column being resized) still shows the surface behind the table.
   */
  filled?: boolean;
}

const tableHeaderVariants = cva('', {
  variants: {
    sticky: {
      true: 'sticky top-0 z-50',
      false: '',
    },
    filled: {
      true: 'bg-surface-secondary',
      false: '',
    },
  },
});

const TableHeader: React.ForwardRefExoticComponent<
  TableHeaderProps & React.RefAttributes<HTMLTableSectionElement>
> = React.forwardRef<HTMLTableSectionElement, TableHeaderProps>(
  ({ className, sticky = false, filled = true, ...props }, ref) => (
    <thead
      ref={ref}
      className={cn(tableHeaderVariants({ sticky, filled }), className)}
      {...props}
    />
  ),
);
TableHeader.displayName = 'TableHeader';

const TableBody: React.ForwardRefExoticComponent<
  React.HTMLAttributes<HTMLTableSectionElement> & React.RefAttributes<HTMLTableSectionElement>
> = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tbody ref={ref} className={cn('[&_tr:last-child]:border-0', className)} {...props} />
  ),
);
TableBody.displayName = 'TableBody';

const TableFooter: React.ForwardRefExoticComponent<
  React.HTMLAttributes<HTMLTableSectionElement> & React.RefAttributes<HTMLTableSectionElement>
> = React.forwardRef<HTMLTableSectionElement, React.HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, ref) => (
    <tfoot ref={ref} className={cn('bg-surface-secondary font-medium', className)} {...props} />
  ),
);
TableFooter.displayName = 'TableFooter';

const TableRow: React.ForwardRefExoticComponent<
  React.HTMLAttributes<HTMLTableRowElement> & React.RefAttributes<HTMLTableRowElement>
> = React.forwardRef<HTMLTableRowElement, React.HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, ref) => (
    <tr
      ref={ref}
      className={cn(
        /** Rows are separated by their own padding and the hover fill, not by rules:
         *  a ruled table reads as a grid, and a list of records rarely needs one. */
        'hover:bg-surface-hover data-[state=selected]:bg-surface-hover transition-colors',
        className,
      )}
      {...props}
    />
  ),
);
TableRow.displayName = 'TableRow';

/**
 * The rule a theme may draw under each row, 0px by default. It sits on the cells rather than the
 * row: a table with separated borders, which is how the tables that round their hover rows are
 * laid out, never draws a border on a `<tr>`.
 */
const tableCellRule = 'border-b-(length:--theme-table-row-stroke) border-border-light';

/**
 * A header cell's size. `sm` is a compact table's header: a side panel lists records rather than
 * presenting a grid, and a full-height, full-size heading over two text lines reads as scaffolding
 * rather than as the column names those rows sit under. `compact` keeps the header's own type on a
 * compact row height, and `row` is a row's title rendered as a header cell, padded like the compact
 * body cells beside it. Every padding and height reads the theme's table cell space.
 */
const tableHeadVariants = cva('', {
  variants: {
    size: {
      default: '',
      sm: 'h-auto py-theme-table-cell-compact text-xs',
      compact: 'h-theme-table-head-compact py-theme-table-cell-compact',
      row: 'py-theme-table-cell-dense sm:py-theme-table-cell-compact',
    },
  },
  defaultVariants: { size: 'default' },
});

type TableHeadSize = 'default' | 'sm' | 'compact' | 'row';

const TableHead: React.ForwardRefExoticComponent<
  React.ThHTMLAttributes<HTMLTableCellElement> &
    React.RefAttributes<HTMLTableCellElement> & { size?: TableHeadSize }
> = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & { size?: TableHeadSize }
>(({ className, size, ...props }, ref) => (
  <th
    ref={ref}
    className={cn(
      tableCellRule,
      'text-table-header-text h-theme-table-head px-4 text-left align-middle font-medium [&:has([role=checkbox])]:pr-0',
      tableHeadVariants({ size }),
      className,
    )}
    {...props}
  />
));
TableHead.displayName = 'TableHead';

/**
 * A body cell's vertical space, from the theme's table cell space: `default` is the full space,
 * `compact` a quarter of it on a narrow screen and half from `sm` up, and `dense` a quarter at
 * every width. Click UI's own table sizes halve the same way (`md` 1rem, `sm` 0.5rem).
 */
const tableCellVariants = cva('', {
  variants: {
    size: {
      default: 'py-theme-table-cell',
      compact: 'py-theme-table-cell-dense sm:py-theme-table-cell-compact',
      dense: 'py-theme-table-cell-dense',
    },
  },
  defaultVariants: { size: 'default' },
});

type TableCellSize = 'default' | 'compact' | 'dense';

const TableCell: React.ForwardRefExoticComponent<
  React.TdHTMLAttributes<HTMLTableCellElement> &
    React.RefAttributes<HTMLTableCellElement> & { size?: TableCellSize }
> = React.forwardRef<
  HTMLTableCellElement,
  React.TdHTMLAttributes<HTMLTableCellElement> & { size?: TableCellSize }
>(({ className, size, ...props }, ref) => (
  <td
    ref={ref}
    className={cn(
      tableCellRule,
      'px-4 align-middle [&:has([role=checkbox])]:pr-0',
      tableCellVariants({ size }),
      className,
    )}
    {...props}
  />
));
TableCell.displayName = 'TableCell';

const TableRowHeader: React.ForwardRefExoticComponent<
  React.ThHTMLAttributes<HTMLTableCellElement> &
    React.RefAttributes<HTMLTableCellElement> & { size?: TableCellSize }
> = React.forwardRef<
  HTMLTableCellElement,
  React.ThHTMLAttributes<HTMLTableCellElement> & { size?: TableCellSize }
>(({ className, size, ...props }, ref) => (
  <th
    ref={ref}
    scope="row"
    className={cn(
      tableCellRule,
      'px-4 text-left align-middle font-medium [&:has([role=checkbox])]:pr-0',
      tableCellVariants({ size }),
      className,
    )}
    {...props}
  />
));
TableRowHeader.displayName = 'TableRowHeader';

const TableCaption: React.ForwardRefExoticComponent<
  React.HTMLAttributes<HTMLTableCaptionElement> & React.RefAttributes<HTMLTableCaptionElement>
> = React.forwardRef<HTMLTableCaptionElement, React.HTMLAttributes<HTMLTableCaptionElement>>(
  ({ className, ...props }, ref) => (
    <caption ref={ref} className={cn('text-text-secondary mt-4 text-sm', className)} {...props} />
  ),
);
TableCaption.displayName = 'TableCaption';

export {
  Table,
  TableHeader,
  TableBody,
  TableFooter,
  TableHead,
  TableRow,
  TableCell,
  TableRowHeader,
  TableCaption,
};
