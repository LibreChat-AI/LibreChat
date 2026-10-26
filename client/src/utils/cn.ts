import { type ClassValue, clsx } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

/** Mirrors `TYPE_STEPS` in `@librechat/client`; imported values there are mocked away in specs. */
const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: ['3xs', '2xs', '1xs', '1sm'] }] } },
});

/**
 * Merges the tailwind clases (using twMerge). Conditionally removes false values
 * @param inputs The tailwind classes to merge
 * @returns className string to apply to an element or HOC
 */
export default function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
