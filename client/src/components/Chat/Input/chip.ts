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

/** The popover the rail's chips open. Menus open above their chip, so they rise a few pixels
 *  from its edge while fading and scaling in, and leave on the faster theme step. */
export const chipMenuClasses = cn(
  'z-50 flex max-w-[min(340px,calc(100vw-2rem))] min-w-[240px] flex-col rounded-2xl',
  'border-border-menu bg-surface-menu max-h-[var(--popover-available-height)] overflow-y-auto border p-1 shadow-lg',
  'origin-bottom-left translate-y-1 scale-95 opacity-0',
  'transition duration-theme-normal ease-out motion-reduce:transition-none',
  'data-[enter]:translate-y-0 data-[enter]:scale-100 data-[enter]:opacity-100',
  'data-[leave]:duration-theme-fast data-[leave]:ease-in',
);

export const chipMenuHeadingClasses = 'px-2.5 pt-2 pb-1 text-xs font-semibold text-text-secondary';

export const chipMenuItemClasses = (selected = false) =>
  cn(
    'group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5',
    'outline-hidden transition-colors duration-theme-fast',
    'hover:bg-surface-hover data-[active-item]:bg-surface-hover',
    'aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
    selected && 'bg-surface-active-alt',
  );
