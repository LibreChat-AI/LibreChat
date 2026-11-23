import { cva } from 'class-variance-authority';
import type { ClassProp } from 'class-variance-authority/types';

type DisclosureChevronVariantOptions = ({ expanded?: boolean } & ClassProp) | undefined;

/**
 * Appearance for the chevron that opens a disclosure row: always visible, so
 * every row reads as expandable at a glance, and rotated once the panel is open.
 *
 * Owned here rather than in the feature so a change to the reveal, the focus
 * behaviour, the motion, or the theme role reaches every disclosure surface at
 * once. Callers keep only geometry (the icon size and any optical offset),
 * which legitimately differs per row.
 */
export const disclosureChevronVariants: (props?: DisclosureChevronVariantOptions) => string = cva(
  'shrink-0 text-text-secondary transition-transform duration-200 ease-out motion-reduce:transition-none',
  {
    variants: {
      expanded: {
        true: 'rotate-180',
        false: '',
      },
    },
    defaultVariants: {
      expanded: false,
    },
  },
);
