import { Skeleton } from '@librechat/client';

/** Mirrors ListCard's stacked name and one-liner */
export default function PromptGroupSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="mb-1.5 h-[4.5rem] w-full rounded-xl" />
      ))}
    </div>
  );
}
