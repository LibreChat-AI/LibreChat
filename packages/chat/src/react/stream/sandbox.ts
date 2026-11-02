import { atom } from 'jotai';
import { atomFamily } from 'jotai/utils';
import type { Family } from '../steer/family';

/**
 * True while the backend reported the stateful code sandbox is cold-booting
 * for this tool call (`on_sandbox_starting` SSE event). Keyed by
 * `tool_call_id`; `ExecuteCode`/`BashCall` swap their in-progress label to a
 * "starting sandbox" message while set. Cleared when the tool call's run
 * step completes.
 */
export const sandboxStartingByToolCallId: Family<boolean> = atomFamily((_toolCallId: string) =>
  atom(false),
);
