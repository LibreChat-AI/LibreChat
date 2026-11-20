import { memo } from 'react';
import { getToolDisplayLabel } from '@librechat/chat';
import { ContentTypes } from 'librechat-data-provider';
import { getToolCallIntent, useThreadTailPart } from '@librechat/chat/react';
import type { TMessageContentParts } from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';
import { useLocalize } from '~/hooks';

/** About what one line of the rail holds. */
const TAIL_CHARS = 48;

/**
 * One line for the part a subagent is on: what a tool call says it is for, or the tool's name;
 * the line being written; or that it is thinking. Anything else has no short telling.
 */
export function describeTailPart(
  part: TMessageContentParts,
  localize: LocalizeFunction,
): string | null {
  if (part.type === ContentTypes.TOOL_CALL) {
    const call = part[ContentTypes.TOOL_CALL];
    if (call == null) return null;
    /** Only an agent's call carries arguments and a name; the assistants' call kinds do not. */
    const intent = 'args' in call ? getToolCallIntent(call.args) : undefined;
    if (intent != null && intent !== '') return intent;
    const name = 'name' in call ? call.name : undefined;
    return name ? getToolDisplayLabel(name, localize) : null;
  }
  if (part.type === ContentTypes.THINK) {
    return localize('com_ui_subagent_progress_thinking');
  }
  if (part.type === ContentTypes.TEXT) {
    const text = typeof part.text === 'string' ? part.text : (part.text?.value ?? '');
    const line = text.trimEnd().split('\n').pop()?.trim() ?? '';
    if (line.length <= TAIL_CHARS) return line === '' ? null : line;
    /** The row has one line and the newest words are the news, so a long line is read from its end. */
    const tail = line.slice(-TAIL_CHARS);
    return `…${tail.slice(tail.indexOf(' ') + 1)}`;
  }
  return null;
}

/**
 * What a running subagent is doing now. Its own leaf, so a streamed token redraws this line and
 * not the row; it draws nothing for a thread the page is not following.
 */
function SessionNow({ threadId }: { threadId: string }) {
  const localize = useLocalize();
  const part = useThreadTailPart(threadId, true);
  const line = part == null ? null : describeTailPart(part, localize);
  if (line == null) return null;
  return (
    <p
      data-testid="session-row-now"
      className="text-text-secondary mt-1 truncate text-xs opacity-70"
    >
      {line}
    </p>
  );
}

export default memo(SessionNow);
