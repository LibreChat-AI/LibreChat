import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { cn } from '~/utils';

type SystemEventHeaderProps = {
  icon: ReactNode;
  label: string;
  detail?: string;
  /** Present when the header toggles a disclosure; drives the chevron. */
  expanded?: boolean;
  warning?: boolean;
  /** Announces the label when the row arrives mid-conversation. */
  live?: boolean;
};

export function SystemEventIcon({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="text-text-secondary flex size-5 shrink-0 items-center justify-center"
    >
      {children}
    </span>
  );
}

/**
 * Header line of a system turn — icon, event label, muted detail, chevron.
 * Main chat wake-ups and subagent panel triggers both render it, so the two
 * surfaces cannot drift apart.
 */
export default function SystemEventHeader({
  icon,
  label,
  detail,
  expanded,
  warning = false,
  live = false,
}: SystemEventHeaderProps) {
  return (
    <>
      {icon}
      <span
        className={cn(
          'tool-status-text min-w-0 truncate font-medium',
          warning && 'text-text-warning',
        )}
        title={label}
        role={live ? 'status' : undefined}
      >
        {label}
      </span>
      {detail != null && detail !== '' && (
        <span className="text-text-secondary max-w-[50%] min-w-0 truncate text-xs font-normal">
          · {detail}
        </span>
      )}
      {expanded != null && (
        <ChevronDown
          className={cn(
            'text-text-secondary ml-auto size-4 shrink-0 transition-transform duration-200 ease-out motion-reduce:transition-none',
            expanded && 'rotate-180',
          )}
          aria-hidden="true"
        />
      )}
    </>
  );
}

export const systemEventHeaderClasses =
  'inline-flex h-auto w-full items-center justify-start gap-2 rounded-none bg-transparent p-0 py-1 text-sm text-text-secondary hover:bg-transparent hover:text-text-secondary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-border-heavy focus-visible:ring-offset-0';
