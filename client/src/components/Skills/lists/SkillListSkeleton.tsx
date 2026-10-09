import { Skeleton } from '@librechat/client';

/** Mirrors SkillListItem's compact single-line rows */
export default function SkillListSkeleton({ count = 5 }: { count?: number }) {
  return (
    <div className="flex flex-col gap-2 px-2 pt-2" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} className="h-8 w-full rounded-lg" />
      ))}
    </div>
  );
}
