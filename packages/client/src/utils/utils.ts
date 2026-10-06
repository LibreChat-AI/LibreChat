// ESM utility functions
import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** `text-*` steps off Tailwind's scale; unregistered, twMerge reads them as colors and drops a real one. */
export const TYPE_STEPS = ['3xs', '2xs', '1xs', '1sm'] as const;

/**
 * Theme utilities whose names Tailwind Merge cannot classify, registered so a caller's own
 * padding or height still replaces the primitive's default instead of both surviving
 * and leaving the winner to stylesheet order.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      py: [
        {
          py: [
            'theme-table-cell',
            'theme-table-cell-compact',
            'theme-table-cell-dense',
            'theme-field-y',
          ],
        },
      ],
      h: [
        {
          h: [
            'theme-control',
            'theme-table-head',
            'theme-table-head-compact',
            'theme-button',
            'theme-button-sm',
            'theme-button-xs',
            'theme-button-lg',
            'theme-button-compact',
            'theme-field',
            'theme-field-lg',
            'theme-target',
          ],
        },
      ],
      'min-w': [{ 'min-w': ['theme-tab', 'theme-list', 'theme-target'] }],
      'max-h': [{ 'max-h': ['theme-list'] }],
      'min-h': [{ 'min-h': ['theme-target'] }],
      size: [
        {
          size: [
            'theme-control',
            'theme-button',
            'theme-button-xs',
            'theme-icon-button-sm',
            'theme-checkbox',
            'theme-icon',
            'theme-icon-md',
            'theme-icon-lg',
          ],
        },
      ],
      px: [{ px: ['theme-control-x', 'theme-dialog-x'] }],
      gap: [{ gap: ['theme-control-gap'] }],
      'space-y': [{ 'space-y': ['theme-dialog-header'] }],
      'font-weight': [{ font: ['theme-control', 'theme-dialog-title-weight', 'theme-label'] }],
      'font-family': [{ font: ['theme-dialog-title'] }],
      'font-size': [{ text: [...TYPE_STEPS] }],
    },
  },
});

export const cn = (...inputs: ClassValue[]): string => {
  return twMerge(clsx(inputs));
};
