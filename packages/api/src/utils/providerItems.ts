import { thinkReplayHash, THINK_REPLAY_KEY_PREFIX } from '@librechat/data-schemas';
import type { ReplayCarrierPart } from './message';
import { THINK_REPLAY_FIELD } from './message';

/* Kept apart from `./message`: that module is reached from client code (the message id checks),
 * and `@librechat/data-schemas` pulls in mongoose. */

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
  const attached = content.map((part: ReplayCarrierPart, index) => {
    if (part?.type === 'think') {
      const item = providerItems[`${THINK_REPLAY_KEY_PREFIX}${index}`] as
        | { hash?: unknown; replay?: unknown }
        | undefined;
      /** A reasoning text edited after the response was saved no longer matches its blocks. */
      return item?.replay != null && item.hash === thinkReplayHash(part.think)
        ? { ...part, [THINK_REPLAY_FIELD]: item.replay }
        : part;
    }
    const id = part?.tool_call?.id as string | undefined;
    return id != null && providerItems[id] != null
      ? { ...part, tool_call: { ...part?.tool_call, providerItems: providerItems[id] } }
      : part;
  });
  return { ...message, content: attached };
}
