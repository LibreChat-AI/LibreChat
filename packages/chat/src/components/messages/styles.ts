/** The shared reveal recipe; its reasoning is documented where it is defined. */
export { revealOnRowHoverClasses } from '@librechat/client';

/**
 * The message footer, holding the height of its action row.
 *
 * While an answer streams, every action is withheld and a lone sibling counter
 * renders nothing, so the row measures zero and then springs to the height of the
 * buttons the moment the answer lands. Holding that height from the start is what
 * keeps the transcript from stepping upward under the reader as a response
 * completes. The value is the height of a hover button, `p-1.5` either side of a
 * 19px icon.
 */
export const messageFooterClasses = 'min-h-[1.9375rem] text-xs';
