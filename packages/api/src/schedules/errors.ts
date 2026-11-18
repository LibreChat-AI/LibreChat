import { ContentTypes } from 'librechat-data-provider';

const PROVIDER_ERROR = 'Run ended with a model provider error';

/** Returns a safe error when a response has an error part and no text answer. */
export function getScheduledRunError(content: unknown): string | null {
  if (!Array.isArray(content)) {
    return null;
  }
  let hasError = false;
  for (const part of content) {
    if (typeof part !== 'object' || part === null || !('type' in part)) {
      continue;
    }
    if (part.type === ContentTypes.TEXT && 'text' in part) {
      if (typeof part.text === 'string' && part.text.trim().length > 0) {
        return null;
      }
    }
    if (part.type === ContentTypes.ERROR) {
      hasError = true;
    }
  }
  return hasError ? PROVIDER_ERROR : null;
}
