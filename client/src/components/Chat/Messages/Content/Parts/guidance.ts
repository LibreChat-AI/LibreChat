import type { BackgroundTaskDisplay } from './background';
import type { TranslationKeys } from '~/hooks';

const RAW_DETAILS_KEY: TranslationKeys = 'com_ui_background_tasks_more_in_raw_details';

/** Backend messages are model-facing English; show localized labels, not their raw prose. */
const NOTE_KEYS: Record<string, TranslationKeys> = {
  'Generated files were saved and attached to the tool call that dispatched this task.':
    'com_ui_background_tasks_files_attached',
  'Output and any generated files are being attached to the tool call that dispatched this task.':
    'com_ui_background_tasks_files_attaching',
  'The tool produced an artifact that is not included inline.':
    'com_ui_background_tasks_artifact_not_inline',
  'Still running outside this turn; its result will arrive as a new turn when it finishes.':
    'com_ui_background_tasks_running_elsewhere',
  'Finished, but its result has not been delivered; it will arrive as a new turn unless you poll or cancel it.':
    'com_ui_background_tasks_pending_delivery_note',
  'Automatic delivery failed; this result will not arrive as a new turn. Poll it to collect the result.':
    'com_ui_background_tasks_failed_delivery_note',
};

const MESSAGE_KEYS: Record<string, TranslationKeys> = {
  'Cancellation was requested. The task remains active until its executor settles; poll again for a terminal result.':
    'com_ui_background_tasks_cancellation_requested',
  'Automatic completion delivery is enabled for this subagent task. Continue independent work if available; otherwise end this turn and the host will resume you when the task finishes. Do not repeatedly poll an unchanged running task. Use check_background_task only for explicit status or control, or as a fallback if automatic delivery is unavailable.':
    'com_ui_background_tasks_subagent_wakeup_guidance',
  'This subagent resumes you automatically when it finishes, so there is no need to check again. If you do, wait next_check_s and pass since: activity.cursor.':
    'com_ui_background_tasks_subagent_wakeup_guidance',
  'Results are not pushed for this subagent. Check again after next_check_s, passing since: activity.cursor to get only new activity.':
    'com_ui_background_tasks_subagent_poll_guidance',
};

const NOTICE_KEYS: Record<string, TranslationKeys> = {
  invalid: 'com_ui_background_tasks_notice_invalid',
  rejected: 'com_ui_background_tasks_notice_rejected',
  unavailable: 'com_ui_background_tasks_notice_unavailable',
  not_found: 'com_ui_background_tasks_notice_not_found',
  outcome_unknown: 'com_ui_background_tasks_notice_outcome_unknown',
  result_unavailable: 'com_ui_background_tasks_notice_result_unavailable',
  result_persisting: 'com_ui_background_tasks_notice_result_persisting',
  delivery_scheduled: 'com_ui_background_tasks_notice_delivery_scheduled',
  cancelled: 'com_ui_background_tasks_result_discarded',
  error: 'com_ui_background_tasks_notice_error',
};

export const backgroundTaskNoteKey = (note: string): TranslationKeys =>
  Object.hasOwn(NOTE_KEYS, note) ? NOTE_KEYS[note] : RAW_DETAILS_KEY;

export const backgroundTaskMessageKey = (message: string): TranslationKeys =>
  Object.hasOwn(MESSAGE_KEYS, message) ? MESSAGE_KEYS[message] : RAW_DETAILS_KEY;

export function backgroundTaskNoticeKey(status: string, message: string): TranslationKeys {
  if (
    status === 'invalid' &&
    message === 'Cancellation is not enabled for ordinary background tools.'
  ) {
    return 'com_ui_background_tasks_cancel_disabled';
  }
  if (
    status === 'invalid' &&
    message === 'This control action is supported only for subagent tasks.'
  ) {
    return 'com_ui_background_tasks_notice_subagent_only';
  }
  if (
    status === 'unavailable' &&
    message.startsWith('The pending result could not be discarded right now.')
  ) {
    return 'com_ui_background_tasks_notice_discard_unavailable';
  }
  return Object.hasOwn(NOTICE_KEYS, status) ? NOTICE_KEYS[status] : RAW_DETAILS_KEY;
}

export function backgroundListGuidanceKeys(
  display: Extract<BackgroundTaskDisplay, { kind: 'list' }>,
): TranslationKeys[] {
  if (!display.message) {
    return [];
  }
  let toolPending = false;
  let toolFailed = false;
  let subagentPending = false;
  let subagentRunning = false;
  for (const task of display.tasks) {
    if (task.toolName === 'subagent') {
      subagentPending ||= task.delivery === 'pending' && task.status !== 'running';
      subagentRunning ||= task.status === 'running';
      continue;
    }
    toolPending ||= task.delivery === 'pending' && task.status !== 'running';
    toolFailed ||= task.delivery === 'failed';
  }
  const keys: TranslationKeys[] = [];
  if (toolPending) {
    keys.push('com_ui_background_tasks_pending_delivery_guidance');
  }
  if (toolFailed) {
    keys.push('com_ui_background_tasks_failed_delivery_guidance');
  }
  if (subagentPending) {
    keys.push('com_ui_background_tasks_subagent_pending_guidance');
  }
  if (
    subagentRunning &&
    display.message.includes('Automatic completion delivery is enabled for this subagent task.')
  ) {
    keys.push('com_ui_background_tasks_subagent_wakeup_guidance');
  }
  return keys.length > 0 ? keys : [RAW_DETAILS_KEY];
}
