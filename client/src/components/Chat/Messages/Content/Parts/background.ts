import type { BackgroundTaskDelivery } from 'librechat-data-provider';
import type { WakeupTaskStatus } from './wakeup';

export type BackgroundTaskStatus =
  | WakeupTaskStatus
  | 'running'
  | 'stopping'
  | 'dispatched'
  | 'failed'
  | 'interrupted';

export type BackgroundTaskView = {
  taskId: string;
  toolName: string;
  status: BackgroundTaskStatus;
  result?: string;
  error?: string;
  note?: string;
  message?: string;
  subagentType?: string;
  resultAvailable?: boolean;
  delivery?: BackgroundTaskDelivery;
};

export type BackgroundTaskDisplay =
  | { kind: 'task'; task: BackgroundTaskView }
  | {
      kind: 'list';
      tasks: BackgroundTaskView[];
      partial: boolean;
      warning?: string;
      message?: string;
    }
  | { kind: 'notice'; message: string; status: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value != null && typeof value === 'object' && !Array.isArray(value);

const optionalString = (value: unknown): value is string | undefined =>
  value === undefined || typeof value === 'string';

const taskStatus = (value: unknown): BackgroundTaskStatus | null => {
  if (value === 'cancellation_requested') {
    return 'stopping';
  }
  if (
    value === 'running' ||
    value === 'completed' ||
    value === 'error' ||
    value === 'cancelled' ||
    value === 'dispatched' ||
    value === 'failed' ||
    value === 'interrupted'
  ) {
    return value;
  }
  return null;
};

const deliveryStatus = (value: unknown): value is BackgroundTaskDelivery | undefined =>
  value === undefined || value === 'pending' || value === 'failed' || value === 'delivered';

function parseTask(value: unknown): BackgroundTaskView | null {
  if (!isRecord(value)) {
    return null;
  }
  const status = taskStatus(value.status);
  if (
    typeof value.background_task_id !== 'string' ||
    value.background_task_id === '' ||
    typeof value.tool !== 'string' ||
    value.tool === '' ||
    status == null ||
    !optionalString(value.result) ||
    !optionalString(value.error) ||
    !optionalString(value.note) ||
    !optionalString(value.message) ||
    !optionalString(value.subagent_type) ||
    (value.result_available != null && typeof value.result_available !== 'boolean') ||
    !deliveryStatus(value.delivery)
  ) {
    return null;
  }
  return {
    taskId: value.background_task_id,
    toolName: value.tool,
    status,
    ...(typeof value.result === 'string' ? { result: value.result } : {}),
    ...(typeof value.error === 'string' ? { error: value.error } : {}),
    ...(typeof value.note === 'string' ? { note: value.note } : {}),
    ...(typeof value.message === 'string' ? { message: value.message } : {}),
    ...(typeof value.subagent_type === 'string' ? { subagentType: value.subagent_type } : {}),
    ...(value.result_available === true ? { resultAvailable: true } : {}),
    ...(value.delivery != null ? { delivery: value.delivery } : {}),
  };
}

/** Only host-shaped results become cards. Unknown or partial output stays visible as raw tool output. */
export function parseBackgroundTaskOutput(output?: string | null): BackgroundTaskDisplay | null {
  if (!output || output.length > 2_000_000) {
    return null;
  }
  const text = output.trim();
  if (!text.startsWith('{') || !text.endsWith('}')) {
    return null;
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(payload)) {
    return null;
  }
  if ('tasks' in payload && !Array.isArray(payload.tasks)) {
    return null;
  }
  if (Array.isArray(payload.tasks)) {
    const tasks = payload.tasks.map(parseTask);
    if (tasks.some((task) => task == null)) {
      return null;
    }
    return {
      kind: 'list',
      tasks: tasks as BackgroundTaskView[],
      partial: payload.partial === true,
      ...(typeof payload.warning === 'string' ? { warning: payload.warning } : {}),
      ...(typeof payload.message === 'string' ? { message: payload.message } : {}),
    };
  }
  const task = parseTask(payload);
  if (task != null) {
    return { kind: 'task', task };
  }
  if (typeof payload.status === 'string' && typeof payload.message === 'string') {
    return { kind: 'notice', status: payload.status, message: payload.message };
  }
  return null;
}
