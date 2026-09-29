// ESM utility functions
import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Theme utilities whose names Tailwind Merge cannot classify, registered so a caller's own
 * padding or height still replaces the primitive's default instead of both surviving
 * and leaving the winner to stylesheet order.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      py: [{ py: ['theme-table-cell', 'theme-table-cell-compact', 'theme-table-cell-dense'] }],
      h: [
        { h: ['theme-table-head', 'theme-table-head-compact', 'theme-button', 'theme-button-sm'] },
      ],
      px: [{ px: ['theme-control-x'] }],
      gap: [{ gap: ['theme-control-gap'] }],
      'font-weight': [{ font: ['theme-control'] }],
    },
  },
});

export const cn = (...inputs: ClassValue[]): string => {
  return twMerge(clsx(inputs));
};
