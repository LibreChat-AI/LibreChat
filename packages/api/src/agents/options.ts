import type { AgentToolOptions } from 'librechat-data-provider';

// Security ceilings, not tunable quotas: legacy reads and authoring must share the same bounds.
export const MAX_TOOL_OPTION_KEY_LENGTH = 1024;
export const MAX_TOOL_OPTION_ENTRIES = 1024;
export const MAX_TOOL_OPTION_KEY_BYTES = 64 * 1024;

export const AGENT_TOOL_OPTIONS_LIMIT_EXCEEDED = 'AGENT_TOOL_OPTIONS_LIMIT_EXCEEDED';

export class ToolOptionsLimitError extends RangeError {
  readonly code: string = AGENT_TOOL_OPTIONS_LIMIT_EXCEEDED;

  constructor(message: string) {
    super(message);
    this.name = 'ToolOptionsLimitError';
  }
}

export function getToolOptionsLimitError(options?: object): string | undefined {
  let count = 0;
  let bytes = 0;
  for (const name in options) {
    if (!Object.prototype.hasOwnProperty.call(options, name)) continue;
    if (name.length > MAX_TOOL_OPTION_KEY_LENGTH) {
      return 'Tool option key exceeds the safety length limit';
    }
    if (++count > MAX_TOOL_OPTION_ENTRIES) {
      return 'Tool options exceed the safety entry limit';
    }
    bytes += Buffer.byteLength(name, 'utf8');
    if (bytes > MAX_TOOL_OPTION_KEY_BYTES) {
      return 'Tool option keys exceed the safety byte limit';
    }
  }
  return undefined;
}

export function assertToolOptionsWithinLimits(options?: AgentToolOptions): void {
  const error = getToolOptionsLimitError(getPersistedToolOptions(options));
  if (error) throw new ToolOptionsLimitError(error);
}

const persistedToolOptions = new WeakMap<AgentToolOptions, AgentToolOptions>();

/** This view is for safety accounting, never runtime approval matching. */
export function getPersistedToolOptions(options?: AgentToolOptions): AgentToolOptions | undefined {
  return options && (persistedToolOptions.get(options) ?? options);
}

/** Capture the bounded persisted view before runtime keys are transformed. */
export function capturePersistedToolOptions(options: AgentToolOptions): AgentToolOptions {
  let persisted = persistedToolOptions.get(options);
  if (!persisted) {
    assertToolOptionsWithinLimits(options);
    persisted = { ...options };
    persistedToolOptions.set(options, persisted);
  }
  return persisted;
}

/** Trusted copies and rewrites retain limits without replacing their effective entries. */
export function retainToolOptionsLimits(target: AgentToolOptions, source?: AgentToolOptions): void {
  if (source) persistedToolOptions.set(target, capturePersistedToolOptions(source));
}
