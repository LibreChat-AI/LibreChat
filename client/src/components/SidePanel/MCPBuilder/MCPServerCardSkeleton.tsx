import { Skeleton } from '@librechat/client';

/** Mirrors MCPServerCard: square icon, then name over description */
export default function MCPServerCardSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-3 rounded-lg px-3 py-2.5">
          <Skeleton className="size-8 shrink-0 rounded-lg" />
          <div className="flex min-w-0 flex-1 flex-col gap-1.5">
            <Skeleton className="h-4 w-28 rounded" />
            <Skeleton className="h-3 w-full rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
