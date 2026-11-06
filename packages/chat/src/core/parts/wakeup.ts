import type { TMessage } from 'librechat-data-provider';

export type WakeupTaskStatus = 'completed' | 'error' | 'cancelled';

export type WakeupTask = {
  taskId: string;
  status: WakeupTaskStatus;
  result: string;
  /** Durable child-thread identity — present for subagent completions. */
  threadId?: string;
  subagentType?: string;
  /** Parent tool-call identity — present for background tool completions. */
  toolCallId?: string;
  toolName?: string;
};

export type WakeupDisplay = {
  kind: 'subagent' | 'background_tool';
  tasks: WakeupTask[];
};

/** Mirrors `renderWakeupInput` in `packages/api/src/agents/subagentCompletionWakeup.ts`. */
const SUBAGENT_WAKEUP_HEADER =
  /^A detached subagent task has (completed|error|cancelled)\. Continue the parent task using its durable result below\.\n/;

/** Mirrors `buildWakeupInput` in `packages/api/src/agents/backgroundCompletionWakeup.ts`. */
const BACKGROUND_WAKEUP_HEADER =
  /^(?:A background tool task has finished\. Continue using its durable result below\.|\d+ background tool tasks have finished\. Continue using their durable results below\.)\n/;

const MAX_WAKEUP_TEXT_CHARS = 512 * 1024;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const wakeupStatus = (value: unknown): WakeupTaskStatus | null =>
  value === 'completed' || value === 'error' || value === 'cancelled' ? value : null;

const parsePayloadLine = (body: string): unknown => {
  const payloadLine = body.split('\n', 1)[0] ?? '';
  try {
    return JSON.parse(payloadLine) as unknown;
  } catch {
    return null;
  }
};

const subagentWakeupTask = (payload: unknown): WakeupTask | null => {
  if (!isRecord(payload)) {
    return null;
  }
  const status = wakeupStatus(payload.status);
  if (
    status == null ||
    typeof payload.background_task_id !== 'string' ||
    typeof payload.subagent_thread_id !== 'string' ||
    typeof payload.subagent_type !== 'string' ||
    typeof payload.result !== 'string'
  ) {
    return null;
  }
  return {
    taskId: payload.background_task_id,
    status,
    result: payload.result,
    threadId: payload.subagent_thread_id,
    subagentType: payload.subagent_type,
  };
};

const backgroundWakeupTask = (payload: unknown): WakeupTask | null => {
  if (!isRecord(payload)) {
    return null;
  }
  const status = wakeupStatus(payload.status);
  if (
    status == null ||
    typeof payload.background_task_id !== 'string' ||
    typeof payload.tool_call_id !== 'string' ||
    typeof payload.tool !== 'string' ||
    typeof payload.result !== 'string'
  ) {
    return null;
  }
  return {
    taskId: payload.background_task_id,
    status,
    result: payload.result,
    toolCallId: payload.tool_call_id,
    toolName: payload.tool,
  };
};

/**
 * Detects a host-authored wake-up continuation message (a detached subagent or
 * background tool task settling and resuming the parent run) so the UI can
 * render a task card instead of the model-facing prompt JSON. The strict
 * header + payload shape check is intentional: ordinary user text quoting one
 * of these prompts mid-message must never collapse into a card.
 */
export function parseWakeupText(text?: string | null): WakeupDisplay | null {
  if (!text || text.length > MAX_WAKEUP_TEXT_CHARS) {
    return null;
  }

  const subagentHeader = SUBAGENT_WAKEUP_HEADER.exec(text);
  if (subagentHeader != null) {
    const task = subagentWakeupTask(parsePayloadLine(text.slice(subagentHeader[0].length)));
    if (task == null || task.status !== subagentHeader[1]) {
      return null;
    }
    return { kind: 'subagent', tasks: [task] };
  }

  const backgroundHeader = BACKGROUND_WAKEUP_HEADER.exec(text);
  if (backgroundHeader == null) {
    return null;
  }
  const payload = parsePayloadLine(text.slice(backgroundHeader[0].length));
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }
  const tasks = payload.map(backgroundWakeupTask);
  if (tasks.some((task) => task == null)) {
    return null;
  }
  return { kind: 'background_tool', tasks: tasks as WakeupTask[] };
}

/** User-submitted lookalikes are ordinary prompts. Older host wake-ups may omit
 *  provenance, so retain their existing strict header/payload compatibility. */
export function parseWakeupMessage(
  message: Pick<TMessage, 'text' | 'isCreatedByUser' | 'isUserSubmitted'> | undefined,
): WakeupDisplay | null {
  if (message?.isCreatedByUser !== true || message.isUserSubmitted === true) return null;
  return parseWakeupText(message.text);
}
