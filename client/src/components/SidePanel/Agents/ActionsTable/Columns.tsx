import { SeriesLabel } from '@librechat/client';
import type { SeriesLabelHue } from '@librechat/client';
import type { ColumnDef } from '@tanstack/react-table';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';

export type Spec = {
  name: string;
  method: string;
  path: string;
  domain: string;
};

/**
 * Color-codes the HTTP verb the way API docs do, so the method reads at a
 * glance. The hues come from the categorical series ramp (identity rather than
 * status), chosen to stay close to the conventional verb colours. `delete`
 * takes the error role, because destructive really is a status.
 */
const METHOD_HUES: Record<string, SeriesLabelHue | undefined> = {
  get: 1,
  post: 7,
  put: 4,
  patch: 6,
  delete: 'error',
};

function HeaderCell({ labelKey }: { labelKey: TranslationKeys }) {
  const localize = useLocalize();
  return <>{localize(labelKey)}</>;
}

function MethodBadge({ method }: { method: string }) {
  return (
    <SeriesLabel
      hue={METHOD_HUES[method.toLowerCase()]}
      className="font-mono text-[11px] font-semibold tracking-wide uppercase"
    >
      {method}
    </SeriesLabel>
  );
}

export const columns: ColumnDef<Spec>[] = [
  {
    accessorKey: 'name',
    header: () => <HeaderCell labelKey="com_ui_name" />,
    cell: ({ row }) => <span className="text-text-primary font-medium">{row.original.name}</span>,
  },
  {
    accessorKey: 'method',
    header: () => <HeaderCell labelKey="com_ui_method" />,
    cell: ({ row }) => <MethodBadge method={row.original.method} />,
  },
  {
    accessorKey: 'path',
    header: () => <HeaderCell labelKey="com_ui_path" />,
    cell: ({ row }) => (
      <span className="text-text-secondary font-mono text-xs break-all">{row.original.path}</span>
    ),
  },
];
