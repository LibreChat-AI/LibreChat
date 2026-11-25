import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/**
 * Mirrors `TYPE_STEPS` in `@librechat/client`; imported values there are mocked away in specs. The
 * button's default size utilities are registered so a variant's own padding and height replace
 * them, instead of both surviving and leaving the winner to stylesheet order.
 */
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [{ text: ['3xs', '2xs', '1xs', '1sm'] }],
      h: [{ h: ['theme-button'] }],
      px: [{ px: ['theme-button-x'] }],
    },
  },
});

/**
 * Merges the tailwind clases (using twMerge). Conditionally removes false values
 * @param inputs The tailwind classes to merge
 * @returns className string to apply to an element or HOC
 */
export default function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
