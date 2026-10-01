import type { ReactNode } from 'react';
import { cn } from '~/utils';

export function parseShortcutKeys(display: string): string[] {
  return display.split(/([+\s]+)/).filter((key) => key.trim().length > 0 && key !== '+');
}

function ShortcutKbd({ children, className = '' }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        'border-border-light bg-surface-primary-alt text-text-primary inline-flex h-[1.375rem] min-w-[1.375rem] items-center justify-center rounded-md border px-1.5 font-sans text-[0.6875rem] leading-none font-medium',
        className,
      )}
    >
      {children}
    </kbd>
  );
}

export default function ShortcutKeyCombo({
  display,
  keys,
  className = '',
  keyClassName = '',
}: {
  display?: string;
  keys?: string[];
  className?: string;
  keyClassName?: string;
}) {
  const shortcutKeys = keys ?? parseShortcutKeys(display ?? '');

  return (
    <div className={cn('flex items-center gap-1', className)}>
      {shortcutKeys.map((key, idx) => (
        <ShortcutKbd key={`${key}-${idx}`} className={keyClassName}>
          {key}
        </ShortcutKbd>
      ))}
    </div>
  );
}
