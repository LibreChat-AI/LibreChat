import type { TMessageContentParts } from './types/content';
import type { Agents } from './types/agents';

/**
 * Query parameter a client adds to a conversation's message load to receive bounded previews of
 * settled tool calls instead of their full output, arguments and subagent transcripts. A server
 * that predates previews ignores it, and a client that omits it receives the full payload, so
 * either side can upgrade first.
 */
export const TOOL_CALL_PREVIEWS_PARAM = 'toolPreviews';

/** The preview format this client understands; a later format bumps it. */
export const TOOL_CALL_PREVIEWS_VERSION = '1';

/** Markers the server sets on a tool call whose content it shortened or left out. */
export type ToolCallPreviewMarkers = Pick<
  Agents.ToolCall,
  | 'outputTruncated'
  | 'outputLength'
  | 'argsTruncated'
  | 'argsLength'
  | 'subagentContentOmitted'
  | 'subagentContentParts'
>;

/** A tool call as the full-part endpoint returns it, transcript included. */
export type FullToolCall = Agents.ToolCall & { subagent_content?: TMessageContentParts[] };

/** True when any of the tool call's content is a preview rather than the stored value. */
export function hasToolCallPreview(toolCall: ToolCallPreviewMarkers | null | undefined): boolean {
  return (
    toolCall?.outputTruncated === true ||
    toolCall?.argsTruncated === true ||
    toolCall?.subagentContentOmitted === true
  );
}

/**
 * The exit-status trailer the attached-workspace `bash_tool` appends to its output
 * (`formatCommandResult` in `packages/api/src/code/command.ts`), anchored to the end. Shared so
 * the card that reads the verdict and the server that bounds previews agree on its extent.
 */
export const COMMAND_RESULT_TRAILER: RegExp =
  /\n((?:\[(?:exit code: -?\d+|terminated by [\w+-]+|timed out|output truncated)\])+)((?:\nCommand reached timeoutMs: [^\n]*)?(?:\n\[directory hint: [^\n]*\])?)$/;
