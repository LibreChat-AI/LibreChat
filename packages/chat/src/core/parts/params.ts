/** Whether serialized tool arguments hold anything the info panel can show.
 *  An empty object or array renders nothing, so a card must not count it as
 *  content. Shared by the panel and by the card deciding to drop its row. */
export function hasToolParams(input?: string | null): boolean {
  if (!input || input.trim().length === 0) {
    return false;
  }
  try {
    const parsed = JSON.parse(input);
    if (typeof parsed === 'object' && parsed !== null) {
      return Object.keys(parsed).length > 0;
    }
  } catch {
    // Not JSON
  }
  return input.trim().length > 0;
}
