export const DEFAULT_MESSAGES_PAGE_SIZE = 25;
/** Default ceiling, matching the search page ceiling; `messages.maxPageSize` overrides it. */
export const MAX_MESSAGES_PAGE_SIZE = 1000;

/** Parses the client `pageSize` query value, falling back to the default and never exceeding the cap. */
export function parseMessagesPageSize(
  raw: unknown,
  maxPageSize: number = MAX_MESSAGES_PAGE_SIZE,
): number {
  const parsed =
    typeof raw === 'string' || typeof raw === 'number' ? parseInt(String(raw), 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MESSAGES_PAGE_SIZE;
  }
  return Math.min(parsed, maxPageSize);
}
