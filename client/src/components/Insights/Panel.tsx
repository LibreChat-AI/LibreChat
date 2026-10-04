import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '~/utils';

export function Panel({ className, ...props }: ComponentPropsWithoutRef<'section'>) {
  return (
    <section
      {...props}
      className={cn(
        /** Click UI gives dashboard widgets their own surface and stroke, a step lighter
         *  than the page in dark mode; in light they match the page surface and light rule. */
        'border-chart-widget-stroke bg-chart-widget-surface min-w-0 rounded-lg border p-5',
        className,
      )}
    />
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-text-secondary flex min-h-40 items-center justify-center text-sm">
      {message}
    </div>
  );
}
