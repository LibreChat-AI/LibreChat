import { cva } from 'class-variance-authority';

export type FocusOutline = 'native' | 'hidden' | 'ring';

/** The keyboard ring the `Button` variants draw, in the `focus-control` role. */
export const focusRing: string =
  'ring-offset-surface-primary focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-focus-control focus-visible:ring-offset-2';

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
        ring: focusRing,
      },
    },
    defaultVariants: {
      focusOutline: 'native',
    },
  },
);
