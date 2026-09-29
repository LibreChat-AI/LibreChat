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
      py: [{ py: ['theme-table-cell'] }],
      h: [{ h: ['theme-table-head'] }],
    },
  },
});

export const cn = (...inputs: ClassValue[]): string => {
  return twMerge(clsx(inputs));
};
