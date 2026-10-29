type ToolCallPart = { tool_call?: Record<string, unknown> } | null;

/** Keeps a message document far below the MongoDB size limit; over it no items are kept, so every later turn restores the rounds the same way. */
export const MAX_PROVIDER_ITEMS_CHARS = 2_000_000;

/**
 * Splits the provider output items off the tool call parts of a response
 * (`tool_call.providerItems`: encrypted reasoning and ids of an OpenAI Responses
 * round). They live in a field of their own, outside `content`, so no read of the
 * content can carry them by accident.
 * @returns the content without them, and the items by tool call id (those of a call
 *          without an id are dropped, all of them over the size cap); undefined when the
 *          content has none
 */
export function splitProviderItems(
  content: unknown,
): { content: unknown[]; providerItems: Record<string, unknown> } | undefined {
  if (!Array.isArray(content)) {
    return undefined;
  }
  const providerItems: Record<string, unknown> = {};
  let found = false;
  const stripped = content.map((part: ToolCallPart) => {
    const toolCall = part?.tool_call;
    if (toolCall == null || toolCall.providerItems == null) {
      return part;
    }
    found = true;
    const { providerItems: items, ...rest } = toolCall;
    if (typeof rest.id === 'string' && rest.id !== '') {
      providerItems[rest.id] = items;
    }
    return { ...part, tool_call: rest };
  });
  if (!found) {
    return undefined;
  }
  return {
    content: stripped,
    providerItems:
      JSON.stringify(providerItems).length <= MAX_PROVIDER_ITEMS_CHARS ? providerItems : {},
  };
}
