/**
 * Brands lineage-only conversation snapshots so consumers do not treat them as authoritative.
 */
export const PARTIAL_RESOLVED_CONVERSATION: unique symbol = Symbol.for(
  'librechat.resolvedConversation.partial',
);
