import { JSX } from 'react/jsx-runtime';
import { cn } from '~/utils';

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>): JSX.Element {
  return (
    <div
      className={cn(
        'bg-surface-tertiary animate-pulse rounded-md opacity-50 motion-reduce:animate-none dark:opacity-25',
        className,
      )}
      {...props}
    />
  );
}

export { Skeleton };
