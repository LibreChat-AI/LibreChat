import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { Collapse } from '~/components/ui';
import { cn } from '~/utils';

/**
 * A labelled, collapsible group; `action` stays reachable while collapsed. `dense` is the
 * sidebar's scale: a small label over rows that carry their own spacing.
 */
export default function Section({
  label,
  count,
  action,
  defaultOpen = true,
  dense = false,
  children,
}: {
  label: string;
  count: number;
  action?: React.ReactNode;
  defaultOpen?: boolean;
  dense?: boolean;
  children: React.ReactNode;
}) {
  const listId = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section>
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
          className={cn(
            'text-text-secondary hover:text-text-primary focus-visible:ring-focus-control flex min-w-0 flex-1 items-center gap-1 rounded focus-visible:ring-2 focus-visible:outline-none',
            dense ? 'h-8 ps-2 text-xs font-medium' : 'text-sm',
          )}
        >
          <span>{label}</span>
          <span className="tabular-nums">{count}</span>
          <ChevronDown
            aria-hidden="true"
            className={cn(
              'size-3.5 shrink-0 transition-transform motion-reduce:transition-none',
              !open && '-rotate-90',
            )}
          />
        </button>
        {action}
      </div>
      <Collapse open={open}>
        <ul id={listId} className={dense ? undefined : 'space-y-2 pt-2'}>
          {children}
        </ul>
      </Collapse>
    </section>
  );
}
