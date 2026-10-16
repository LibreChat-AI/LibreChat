/** The tool a dispatcher call ran (agents SDK `DispatchedToolCall`). */
export type DispatchedToolCall = {
  name: string;
  args: string | Record<string, unknown>;
};

/** Name of the agents SDK dispatcher tool that reaches tools added mid-conversation. */
export const TOOL_DISPATCHER_NAME = 'call_tool';

type DisplayableToolCall = {
  name?: string;
  args?: unknown;
  dispatched?: DispatchedToolCall;
};

function readDispatcherArgs(args: unknown): { name?: unknown; arguments?: unknown } | undefined {
  if (args != null && typeof args === 'object') {
    return args as { name?: unknown; arguments?: unknown };
  }
  if (typeof args !== 'string') {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(args);
    return parsed != null && typeof parsed === 'object' ? parsed : undefined;
  } catch {
    /** Still streaming: the generic card shows the dispatcher until the arguments parse. */
    return undefined;
  }
}

/**
 * The call a tool card shows. A dispatcher call keeps the model's form in the
 * stored part (`name` is the dispatcher), so renderers key on the tool it ran:
 * `dispatched` once it completed, the dispatcher's own arguments before that.
 */
export function resolveDisplayToolCall<T extends DisplayableToolCall>(toolCall: T): T {
  if (toolCall.dispatched != null) {
    return { ...toolCall, name: toolCall.dispatched.name, args: toolCall.dispatched.args };
  }
  if (toolCall.name !== TOOL_DISPATCHER_NAME) {
    return toolCall;
  }
  const dispatcherArgs = readDispatcherArgs(toolCall.args);
  const target = dispatcherArgs?.name;
  if (typeof target !== 'string' || target === '') {
    return toolCall;
  }
  const args = dispatcherArgs?.arguments;
  return {
    ...toolCall,
    name: target,
    args: typeof args === 'string' ? args : JSON.stringify(args ?? {}),
  };
}
