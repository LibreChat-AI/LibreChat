import type { ColumnDef } from '@tanstack/react-table';

export type Spec = {
  name: string;
  method: string;
  path: string;
  domain: string;
};

export const columns: ColumnDef<Spec>[] = [
  {
    header: 'Name',
    accessorKey: 'name',
  },
  {
    header: 'Method',
    accessorKey: 'method',
  },
  {
    header: 'Path',
    accessorKey: 'path',
  },
];
