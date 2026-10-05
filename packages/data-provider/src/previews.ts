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
  | 'previewRevision'
>;

/** A tool call as the full-part endpoint returns it, transcript included. */
export type FullToolCall = Agents.ToolCall & { subagent_content?: TMessageContentParts[] };

/** 32-bit FNV-1a over UTF-16 code units; a fingerprint for cache keys, not a security hash. */
function fingerprint(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

/**
 * Identifies the stored version a preview stands for: the server's `previewRevision` (when the
 * message last changed) plus a fingerprint of everything the preview itself carries. Either
 * changes when the stored call does, so a client cache of the full part keyed on it never
 * outlives the content it was fetched for.
 */
export function getToolCallPreviewRevision(toolCall: FullToolCall): string {
  const output = typeof toolCall.output === 'string' ? toolCall.output : '';
  const args =
    typeof toolCall.args === 'string' ? toolCall.args : JSON.stringify(toolCall.args ?? null);
  const content = [
    output,
    args,
    toolCall.outputLength ?? '',
    toolCall.argsLength ?? '',
    toolCall.subagentContentParts ?? '',
  ].join('\u0000');
  return `${toolCall.previewRevision ?? ''}:${fingerprint(content)}`;
}

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
