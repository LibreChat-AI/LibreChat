import {
  disabledInkClasses,
  composerControlClasses,
  mergeComposerClasses,
} from '@librechat/client';

export type ComposerChipClasses = {
  chipClasses: string;
  infoChipClasses: string;
  chipMenuClasses: string;
  chipMenuHeadingClasses: string;
  chipMenuItemClasses: (selected?: boolean) => string;
};

/**
 * Pills and menus for the composer's context rail. Built per call: the control recipe
 * is read then, and the pill's height, gap, and type replace that recipe's own.
 */
export function composerChipClasses(): ComposerChipClasses {
  const chipClasses = mergeComposerClasses(
    composerControlClasses(),
    'h-8 max-w-full min-w-0 gap-1.5 px-2.5 text-xs',
    'focus-visible:ring-2 focus-visible:ring-text-primary focus-visible:outline-hidden',
  );
  const infoChipClasses = mergeComposerClasses(
    chipClasses,
    'border-transparent bg-surface-tertiary text-text-secondary hover:bg-surface-tertiary',
  );
  const chipMenuClasses = [
    'z-50 flex max-w-[min(340px,calc(100vw-2rem))] min-w-[240px] flex-col rounded-theme-popover',
    'border-border-menu bg-surface-menu max-h-[var(--popover-available-height)] overflow-y-auto border p-1 shadow-lg',
    'origin-bottom-left translate-y-1 scale-95 opacity-0',
    'transition duration-theme-normal ease-out motion-reduce:transition-none',
    'data-[enter]:translate-y-0 data-[enter]:scale-100 data-[enter]:opacity-100',
    'data-[leave]:duration-theme-fast data-[leave]:ease-in',
  ].join(' ');
  const chipMenuHeadingClasses = 'px-2.5 pt-2 pb-1 text-xs font-semibold text-text-secondary';
  const chipMenuItemClasses = (selected = false): string => {
    const classes = [
      'group flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5',
      'outline-hidden transition-colors duration-theme-fast',
      'hover:bg-surface-hover data-[active-item]:bg-surface-hover',
      'aria-disabled:cursor-not-allowed aria-disabled:opacity-50',
      disabledInkClasses,
    ];
    if (selected) {
      classes.push('bg-surface-active-alt');
    }
    return classes.join(' ');
  };
  return {
    chipClasses,
    infoChipClasses,
    chipMenuClasses,
    chipMenuHeadingClasses,
    chipMenuItemClasses,
  };
}
