const PROMPT_KEYS = ['prompt', 'description', 'task', 'instructions'] as const;

/** The task a subagent call was given, read from its arguments (JSON text or parsed). */
export function getSubagentPrompt(
  args: string | Record<string, unknown> | null | undefined,
): string | undefined {
  let parsed: unknown = args;
  if (typeof args === 'string') {
    try {
      parsed = JSON.parse(args);
    } catch {
      return undefined;
    }
  }
  if (parsed == null || typeof parsed !== 'object') {
    return undefined;
  }
  for (const key of PROMPT_KEYS) {
    const value = (parsed as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      return value;
    }
  }
  return undefined;
}
