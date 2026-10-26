export const DEFAULT_MESSAGES_PAGE_SIZE = 25;
/** Matches the search page ceiling, so no previously honored search page size changes. */
export const MAX_MESSAGES_PAGE_SIZE = 1000;

/** Parses the client `pageSize` query value, falling back to the default and never exceeding the cap. */
export function parseMessagesPageSize(raw: unknown): number {
  const parsed =
    typeof raw === 'string' || typeof raw === 'number' ? parseInt(String(raw), 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_MESSAGES_PAGE_SIZE;
  }
  return Math.min(parsed, MAX_MESSAGES_PAGE_SIZE);
}
