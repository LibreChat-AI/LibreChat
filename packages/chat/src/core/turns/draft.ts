/**
 * Whether a draft message has enough content to submit: non-whitespace text, or at least one
 * attached file. Lets users send a file without typing a placeholder message alongside it.
 */
export const isSubmittableMessage = (text?: string | null, fileCount = 0): boolean =>
  (text ?? '').trim() !== '' || fileCount > 0;
