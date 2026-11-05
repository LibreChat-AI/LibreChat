/** Verification receipts are server-owned and cannot be supplied by imports or message writes. */
export function withoutNearAIReceipts(message: Record<string, unknown>): Record<string, unknown> {
  const copy = Object.fromEntries(
    Object.entries(message).filter(
      ([key]) => key !== 'metadata.nearai' && !key.startsWith('metadata.nearai.'),
    ),
  );
  const metadata = copy.metadata;
  if (
    metadata != null &&
    typeof metadata === 'object' &&
    !Array.isArray(metadata) &&
    'nearai' in metadata
  ) {
    const { nearai: _nearai, ...rest } = metadata;
    copy.metadata = rest;
  }
  return copy;
}
