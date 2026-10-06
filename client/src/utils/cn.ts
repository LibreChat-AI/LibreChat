import { TYPE_STEPS } from '@librechat/client';
import { extendTailwindMerge } from 'tailwind-merge';
import { type ClassValue, clsx } from 'clsx';

const twMerge = extendTailwindMerge({
  extend: { classGroups: { 'font-size': [{ text: [...TYPE_STEPS] }] } },
});

/**
 * Merges the tailwind clases (using twMerge). Conditionally removes false values
 * @param inputs The tailwind classes to merge
 * @returns className string to apply to an element or HOC
 */
export default function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
