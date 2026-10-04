import type { TMessage } from 'librechat-data-provider';

/**
 * Flat text for Read Aloud. Reasoning ("think") parts are excluded: the
 * model's internal thoughts are never spoken, only the answer.
 */
export const extractMessageContent = (message: TMessage): string => {
  if (typeof message.content === 'string') {
    return message.content;
  }

  if (Array.isArray(message.content)) {
    return message.content
      .map((part) => {
        if (part == null) {
          return '';
        }
        if (typeof part === 'string') {
          return part;
        }
        if ('text' in part) {
          return part.text || '';
        }
        return '';
      })
      .join('');
  }

  return message.text || '';
};
