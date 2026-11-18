import { ContentTypes } from 'librechat-data-provider';
import type {
  SubagentThreadMessage,
  SubagentThreadStatus,
  TMessageContentParts,
} from 'librechat-data-provider';

type TextPart = Extract<TMessageContentParts, { type: ContentTypes.TEXT }>;

export function hasTerminalOutcome(
  content: TMessageContentParts[],
  outcome: SubagentThreadMessage,
  status: SubagentThreadStatus,
): boolean {
  // The SDK result serializer inserts LF between blocks; its stream aggregator does not.
  const separators = status === 'completed' && outcome.error !== true;
  const matches = (parts: string[]): boolean => {
    let index = 0;
    let matched = false;
    for (const part of parts) {
      for (let offset = 0; offset < part.length; offset++) {
        const character = part[offset];
        while (separators && outcome.text[index] === '\n' && character !== '\n') index++;
        if (index === outcome.text.length) return outcome.textTruncated === true && matched;
        if (outcome.text[index] !== character) return false;
        index++;
        matched = true;
      }
    }
    while (separators && outcome.text[index] === '\n') index++;
    return matched && index === outcome.text.length;
  };
  let group: string[] = [];
  let previous: TextPart | undefined;
  for (const part of content) {
    if (part?.type !== ContentTypes.TEXT) {
      if (group.length > 1 && matches(group)) return true;
      group = [];
      previous = undefined;
      continue;
    }
    const text = typeof part.text === 'string' ? part.text : part.text?.value;
    if (text == null) continue;
    if (matches([text])) return true;
    if (
      previous != null &&
      (previous.agentId !== part.agentId ||
        previous.groupId !== part.groupId ||
        previous.phase !== part.phase)
    ) {
      if (group.length > 1 && matches(group)) return true;
      group = [];
    }
    group.push(text);
    previous = part;
  }
  return group.length > 1 && matches(group);
}
