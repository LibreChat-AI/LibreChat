import type { ColumnDef } from '@tanstack/react-table';
import type { TranslationKeys } from '~/hooks';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

export type Spec = {
  name: string;
  method: string;
  path: string;
  domain: string;
};

/**
 * Color-codes the HTTP verb the way API docs do, so the method reads at a
 * glance. The hues come from the categorical series ramp, which is what that
 * scale is for: identity rather than status, contrast-checked per mode, and
 * separable under simulated deuteranopia. Slots are chosen to stay close to the
 * conventional verb colours. `delete` is the one exception, taking the error
 * role, because destructive really is a status.
 */
const METHOD_STYLES: Record<string, string> = {
  get: 'bg-series-1/10 text-series-1',
  post: 'bg-series-7/10 text-series-7',
  put: 'bg-series-4/10 text-series-4',
  patch: 'bg-series-6/10 text-series-6',
  delete: 'bg-status-error-subtle text-status-error',
};

function HeaderCell({ labelKey }: { labelKey: TranslationKeys }) {
  const localize = useLocalize();
  return <>{localize(labelKey)}</>;
}

function MethodBadge({ method }: { method: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wide',
        METHOD_STYLES[method.toLowerCase()] ?? 'bg-surface-secondary text-text-secondary',
      )}
    >
      {method}
    </span>
  );
}

export const columns: ColumnDef<Spec>[] = [
  {
    accessorKey: 'name',
    header: () => <HeaderCell labelKey="com_ui_name" />,
    cell: ({ row }) => <span className="font-medium text-text-primary">{row.original.name}</span>,
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
      <span className="break-all font-mono text-xs text-text-secondary">{row.original.path}</span>
    ),
  },
];
