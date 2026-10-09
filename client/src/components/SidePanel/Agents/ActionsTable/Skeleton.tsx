import { Skeleton } from '@librechat/client';
import { useLocalize } from '~/hooks';

const SKELETON_ROWS = 3;
const HEADER_KEYS = ['com_ui_name', 'com_ui_method', 'com_ui_path'] as const;

/**
 * Loading state for the actions table. Mirrors the table's chrome (eyebrow header,
 * row dividers, a badge-shaped method cell) so the swap to real rows doesn't shift
 * the layout. The headers are real since they never change.
 */
export default function ActionsTableSkeleton() {
  const localize = useLocalize();
  return (
    <table className="w-full table-auto text-sm" aria-busy="true" aria-live="polite">
      <thead>
        <tr className="border-border-light border-b">
          {HEADER_KEYS.map((key) => (
            <th
              key={key}
              className="text-text-secondary py-2 pr-3 text-left text-[11px] font-medium tracking-wide uppercase"
            >
              {localize(key)}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {Array.from({ length: SKELETON_ROWS }, (_, row) => (
          <tr key={row} className="border-border-light border-b last:border-0">
            <td className="py-2.5 pr-3">
              <Skeleton className="h-4 w-24 rounded" />
            </td>
            <td className="py-2.5 pr-3">
              <Skeleton className="h-5 w-12 rounded-md" />
            </td>
            <td className="py-2.5 pr-3">
              <Skeleton className="h-4 w-32 rounded" />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
