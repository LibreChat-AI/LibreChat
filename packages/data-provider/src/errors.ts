const TOOL_CALL_ERROR_PREFIX = /^Error:\s*(?:\[[^\]]*\]\s*)*tool call failed:\s*/i;

export function hasToolCallErrorPrefix(text: string): boolean {
  return TOOL_CALL_ERROR_PREFIX.test(text);
}

export function stripToolCallErrorPrefix(text: string): string {
  return text.replace(TOOL_CALL_ERROR_PREFIX, '');
}
