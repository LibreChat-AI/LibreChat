const TOOL_CALL_ERROR_PREFIX = /^Error:\s*(?:\[[^\]]*\]\s*)*tool call failed:\s*/i;

export function hasToolCallErrorPrefix(text: string): boolean {
  return TOOL_CALL_ERROR_PREFIX.test(text);
}

/** Whether a tool output string is one the tool output renderers present as a failure. */
export function isToolErrorOutput(text: string): boolean {
  return hasToolCallErrorPrefix(text) || text.startsWith('Error processing tool');
}

const VALIDATION_FEEDBACK = /^Error:[\s\S]*\n Please fix your mistakes\.$/i;

/**
 * Whether a completed tool call failed. Agents SDK releases serialize tool failures
 * into these host-authored prefixes, and schema-validation feedback into a plain
 * `Error:` block, without carrying `ToolMessage.status` on the wire.
 */
export function isFailedToolOutput(text: string): boolean {
  return (
    hasToolCallErrorPrefix(text) ||
    /^Error processing tool(?::|$)/i.test(text) ||
    VALIDATION_FEEDBACK.test(text)
  );
}

export function stripToolCallErrorPrefix(text: string): string {
  return text.replace(TOOL_CALL_ERROR_PREFIX, '');
}
