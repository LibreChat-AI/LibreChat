import { useId, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '~/utils';

/** A labelled, collapsible group; `action` stays reachable while collapsed. */
export default function Section({
  label,
  count,
  action,
  defaultOpen = true,
  children,
}: {
  label: string;
  count: number;
  action?: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  const listId = useId();
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="space-y-2">
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((value) => !value)}
          className="flex min-w-0 flex-1 items-center gap-1 rounded text-sm text-text-secondary hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring-primary"
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
      {open && (
        <ul id={listId} className="space-y-2">
          {children}
        </ul>
      )}
    </section>
  );
}
