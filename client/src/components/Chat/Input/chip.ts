import { cn, composerControlClasses } from '@librechat/client';

/** One compact pill for every control in the composer's context rail (project, machine,
 *  workspace, branch, worktree, approval mode), so the rail reads as a single set. */
export const chipClasses = cn(
  composerControlClasses(),
  'h-8 max-w-full min-w-0 gap-1.5 px-2.5 text-xs',
  'focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:outline-hidden',
);

/** Read-only facts (branch) drop the border and sit on a quiet fill so they do not look pressable. */
export const infoChipClasses = cn(
  chipClasses,
  'border-transparent bg-surface-tertiary text-text-secondary hover:bg-surface-tertiary',
);
