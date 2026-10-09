import type { FiltersConfig } from 'librechat-data-provider';
import { extractConversationTitleContent } from './adapters/submissions';
import { inspectContent } from './runtime';

export const SAFE_CONVERSATION_TITLE = 'New Chat';

export interface ResolveConversationTitleOptions {
  readonly filters?: FiltersConfig;
  readonly candidate?: string | null;
  readonly fallback?: string | null;
}

export function resolveConversationTitle({
  filters,
  candidate,
  fallback = SAFE_CONVERSATION_TITLE,
}: ResolveConversationTitleOptions): string | null {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return null;
  }
  if (filters?.conversationTitles?.pii == null) {
    return candidate;
  }

  const isAllowed = (title: string): boolean =>
    inspectContent(extractConversationTitleContent(title), { filters }) == null;

  if (isAllowed(candidate)) {
    return candidate;
  }
  if (
    typeof fallback === 'string' &&
    fallback.length > 0 &&
    fallback !== candidate &&
    isAllowed(fallback)
  ) {
    return fallback;
  }
  return null;
}
