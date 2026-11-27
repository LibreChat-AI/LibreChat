import { Skeleton } from '@librechat/client';

/** Mirrors the healthy schedule row: a state marker, a title line with its trailing
 *  state, and one detail line beside the row's always-present actions. A healthy
 *  row shows no chip. */
export default function ScheduleCardSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: count }, (_, index) => (
        <div key={index} className="rounded-lg bg-transparent px-3 py-2.5">
          <div className="flex items-start gap-2.5">
            <Skeleton className="mt-1.5 size-2 shrink-0 rounded-full" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <Skeleton className="h-5 min-w-0 flex-1 rounded" />
                <Skeleton className="h-3 w-12 shrink-0 rounded" />
              </div>
              <div className="mt-0.5 flex items-center gap-2">
                <Skeleton className="h-3.5 min-w-0 flex-1 rounded" />
                <Skeleton className="h-6 w-11 shrink-0 rounded-full" />
                <Skeleton className="size-7 shrink-0 rounded-md" />
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
