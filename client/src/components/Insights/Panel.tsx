import { Spinner } from '@librechat/client';
import { cn } from '~/utils';

export function Panel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <section
      className={cn(
        /** Click UI gives dashboard widgets their own surface and stroke, a step lighter
         *  than the page in dark mode; in light they match the page surface and light rule. */
        'border-chart-widget-stroke bg-chart-widget-surface min-w-0 rounded-lg border p-5',
        className,
      )}
    >
      {children}
    </section>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-text-secondary flex min-h-40 items-center justify-center text-sm">
      {message}
    </div>
  );
}

export function LoadingState({ message }: { message: string }) {
  return (
    <Panel className="flex min-h-52 flex-col items-center justify-center gap-3">
      <Spinner tone="secondary" className="size-7" />
      <span className="text-text-secondary text-sm">{message}</span>
    </Panel>
  );
}

export function TablePanel({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Panel className="overflow-hidden">
      <h2 className="text-text-primary mb-3 text-base font-semibold">{title}</h2>
      {children}
    </Panel>
  );
}
