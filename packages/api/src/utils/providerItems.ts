/**
 * A stored message with its provider items put back on the tool call parts they belong to, for
 * formatting the history. Same object when it has none; never changes the input.
 */
export function attachProviderItems<
  T extends { content?: unknown; providerItems?: Record<string, unknown> | null },
>(message: T): T {
  const { providerItems, content } = message;
  if (providerItems == null || !Array.isArray(content)) {
    return message;
  }
  const attached = content.map((part: { tool_call?: { id?: string } } | null) => {
    const id = part?.tool_call?.id;
    return id != null && providerItems[id] != null
      ? { ...part, tool_call: { ...part?.tool_call, providerItems: providerItems[id] } }
      : part;
  });
  return { ...message, content: attached };
}
