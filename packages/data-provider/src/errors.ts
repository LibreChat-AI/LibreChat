const TOOL_CALL_ERROR_PREFIX = /^Error:\s*(?:\[[^\]]*\]\s*)*tool call failed:\s*/i;

export function hasToolCallErrorPrefix(text: string): boolean {
  return TOOL_CALL_ERROR_PREFIX.test(text);
}

/** Whether a tool output string is one the tool output renderers present as a failure. */
export function isToolErrorOutput(text: string): boolean {
  return hasToolCallErrorPrefix(text) || text.startsWith('Error processing tool');
}

export function stripToolCallErrorPrefix(text: string): string {
  return text.replace(TOOL_CALL_ERROR_PREFIX, '');
}
