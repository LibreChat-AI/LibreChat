import { cva } from 'class-variance-authority';

export type FocusOutline = 'native' | 'hidden';

/**
 * Whether a control keeps the browser's focus outline. `hidden` is for a caller that
 * draws its own indicator, a ring or a container that lights up, and hides the outline
 * on keyboard focus while keeping the transparent one forced-colors mode shows in its
 * place. `outline-hidden` sets `--tw-outline-style: none`, so a control whose indicator
 * is itself an `outline-*` width keeps `native`: hiding it would erase that outline too.
 */
export const focusOutlineVariants: (props?: { focusOutline?: FocusOutline | null }) => string = cva(
  '',
  {
    variants: {
      focusOutline: {
        native: '',
        hidden: 'focus-visible:outline-hidden',
      },
    },
    defaultVariants: {
      focusOutline: 'native',
    },
  },
);
