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

/** The event type of a stored trigger, by the card its turn renders as. */
const KINDS: ReadonlyMap<string, WakeupDisplay['kind']> = new Map([
  ['subagent.completion', 'subagent'],
  ['background-tool.completion', 'background_tool'],
]);

const within = (text?: string | null): text is string =>
  text != null && text.length > 0 && text.length <= MAX_WAKEUP_TEXT_CHARS;

/** The card for a wake-up of this kind, from the payload line that follows its header. */
function toDisplay(kind: WakeupDisplay['kind'], body: string): WakeupDisplay | null {
  const payload = parsePayloadLine(body);
  if (kind === 'subagent') {
    const task = subagentWakeupTask(payload);
    return task == null ? null : { kind, tasks: [task] };
  }
  if (!Array.isArray(payload) || payload.length === 0) {
    return null;
  }
  const tasks = payload.map(backgroundWakeupTask);
  return tasks.some((task) => task == null) ? null : { kind, tasks: tasks as WakeupTask[] };
}

/**
 * Detects a host-authored wake-up continuation message (a detached subagent or
 * background tool task settling and resuming the parent run) by its text, so the UI can
 * render a task card instead of the model-facing prompt JSON. Only for a message stored
 * before the server recorded what started the turn: `parseWakeupMessage` reads that record
 * where there is one. The strict header + payload shape check is intentional: ordinary
 * user text quoting one of these prompts mid-message must never collapse into a card.
 */
export function parseWakeupText(text?: string | null): WakeupDisplay | null {
  if (!within(text)) {
    return null;
  }

  const subagentHeader = SUBAGENT_WAKEUP_HEADER.exec(text);
  if (subagentHeader != null) {
    const display = toDisplay('subagent', text.slice(subagentHeader[0].length));
    return display?.tasks[0].status === subagentHeader[1] ? display : null;
  }

  const backgroundHeader = BACKGROUND_WAKEUP_HEADER.exec(text);
  return backgroundHeader == null
    ? null
    : toDisplay('background_tool', text.slice(backgroundHeader[0].length));
}

/**
 * The task card a wake-up turn renders as, or null for any other message.
 *
 * What started the turn decides: the server records it on the turn's first message, so a
 * turn a task's completion started is a wake-up whatever its header says, and a turn
 * anything else started is not one whatever its text says. The first line is the prompt
 * the model reads and the second the payload the card is drawn from. A message with no such
 * record was stored before there was one, and is matched by its header as it always was.
 * User-submitted lookalikes are ordinary prompts either way.
 */
export function parseWakeupMessage(
  message: Pick<TMessage, 'text' | 'isCreatedByUser' | 'isUserSubmitted' | 'trigger'> | undefined,
): WakeupDisplay | null {
  if (message?.isCreatedByUser !== true || message.isUserSubmitted === true) return null;
  const type = message.trigger?.event?.type;
  if (type == null) return parseWakeupText(message.text);
  const kind = KINDS.get(type);
  const text = message.text;
  if (kind == null || !within(text)) return null;
  const end = text.indexOf('\n');
  return end < 0 ? null : toDisplay(kind, text.slice(end + 1));
}
