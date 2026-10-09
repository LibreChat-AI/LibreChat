import { Skeleton } from '@librechat/client';

/** Mirrors BookmarkCard: drag handle, then the tag name */
export default function BookmarkCardSkeleton({ count = 6 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="flex items-center gap-2 rounded-lg px-3 py-2.5">
          <Skeleton className="size-4 shrink-0 rounded" />
          <Skeleton className="h-4 min-w-0 flex-1 rounded" />
        </div>
      ))}
    </div>
  );
}
