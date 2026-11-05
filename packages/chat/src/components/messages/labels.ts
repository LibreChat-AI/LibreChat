import type { TMessage } from 'librechat-data-provider';

/** The keys these labels read, so any app's localize function that knows them fits. */
type LabelKey =
  | 'com_endpoint_message_new'
  | 'com_endpoint_message'
  | 'com_ui_prompt'
  | 'com_ui_response';

/** Translates a key with positional values, as `useLocalize` returns. */
type Localize = (phraseKey: LabelKey, options?: Record<string, string | number>) => string;

/** Returns a 1-based message number, or null if depth is absent or invalid. */
const getMessageNumber = (message: TMessage): number | null => {
  if (message.depth == null || message.depth < 0) {
    return null;
  }
  return message.depth + 1;
};

/** The accessible name of a message row, numbered by its depth in the thread when it has one. */
export const getMessageAriaLabel = (message: TMessage, localize: Localize): string => {
  const number = getMessageNumber(message);
  return number != null
    ? localize('com_endpoint_message_new', { 0: number })
    : localize('com_endpoint_message');
};

/**
 * Provides a screen-reader-only heading prefix distinguishing prompts from responses,
 * with an optional 1-based turn number derived from message depth.
 */
export const getHeaderPrefixForScreenReader = (message: TMessage, localize: Localize): string => {
  const number = getMessageNumber(message);
  const suffix = number != null ? ` ${number}` : '';
  return message.isCreatedByUser
    ? `${localize('com_ui_prompt')}${suffix}: `
    : `${localize('com_ui_response')}${suffix}: `;
};
