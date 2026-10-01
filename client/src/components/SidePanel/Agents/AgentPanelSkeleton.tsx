import { Skeleton } from '@librechat/client';

export default function AgentPanelSkeleton() {
  return (
    <div className="h-auto pt-1" aria-hidden="true">
      {/* IDENTITY — inline avatar + name/description */}
      <div className="mt-1 mb-3 flex items-center gap-3">
        <Skeleton className="h-16 w-16 shrink-0 rounded-full" />
        <div className="flex min-w-0 flex-1 flex-col gap-2">
          <Skeleton className="h-9 w-full rounded-xl" />
          <Skeleton className="h-9 w-full rounded-xl" />
        </div>
      </div>

      {/* MODEL + CATEGORY — 2-column grid */}
      <div className="mb-3 grid grid-cols-2 gap-2">
        <div className="flex flex-col">
          <Skeleton className="mb-1 h-3 w-12 rounded" />
          <Skeleton className="h-9 w-full rounded-xl" />
        </div>
        <div className="flex flex-col">
          <Skeleton className="mb-1 h-3 w-16 rounded" />
          <Skeleton className="h-9 w-full rounded-xl" />
        </div>
      </div>

      {/* INSTRUCTIONS */}
      <div className="mb-3 flex flex-col">
        <Skeleton className="mb-1 h-3 w-20 rounded" />
        <Skeleton className="h-[88px] w-full rounded-xl" />
      </div>

      {/* TOOLS — header + a couple of rows */}
      <div className="mb-3 flex flex-col">
        <Skeleton className="mb-1 h-3 w-16 rounded" />
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-10 w-full rounded-lg" />
        </div>
      </div>

      {/* SUPPORT CONTACT */}
      <div className="mb-3 flex flex-col">
        <Skeleton className="mb-1 h-3 w-24 rounded" />
        <div className="space-y-2">
          <Skeleton className="h-9 w-full rounded-xl" />
          <Skeleton className="h-9 w-full rounded-xl" />
        </div>
      </div>
    </div>
  );
}
