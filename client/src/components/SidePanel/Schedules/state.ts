import type { TSchedule, ScheduleRunStatus } from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';
import type { TranslationKeys } from '~/hooks';

/**
 * What a schedule row is doing, as one value.
 *
 * The marker in the margin and the word at the end of the title line are two faces
 * of this, so deriving it once is what keeps a green dot from sitting beside the
 * word "failed". `running` is the only state with nothing to say: its row shows when
 * the next run lands instead.
 */
export type ScheduleRowTone = 'running' | 'paused' | 'warning' | 'error';

export interface ScheduleRowState {
  tone: ScheduleRowTone;
  /** Null while the clock is in charge, which is when the next run speaks instead. */
  label: string | null;
}

/** How a finished run colours the row that owns it. */
const RUN_TONE: Record<ScheduleRunStatus, { tone: ScheduleRowTone; label: TranslationKeys }> = {
  success: { tone: 'running', label: 'com_ui_schedule_last_run' },
  error: { tone: 'error', label: 'com_ui_schedule_last_run_failed' },
  interrupted: { tone: 'error', label: 'com_ui_schedule_last_run_failed' },
  requires_action: { tone: 'warning', label: 'com_ui_schedule_needs_approval' },
  started: { tone: 'running', label: 'com_ui_schedule_run_started' },
  skipped_overlap: { tone: 'running', label: 'com_ui_schedule_run_skipped' },
  skipped_balance: { tone: 'warning', label: 'com_ui_schedule_run_skipped' },
};

/**
 * Read in the order the owner would ask: has something stopped it, is it paused,
 * did the last run end badly, and otherwise it is simply running.
 *
 * A schedule the system disabled reads as paused with an error marker, because the
 * clock has stopped either way and the reason is printed underneath.
 */
export function scheduleRowState(
  schedule: Pick<TSchedule, 'enabled' | 'disabledReason' | 'lastRun'>,
  localize: LocalizeFunction,
): ScheduleRowState {
  if (schedule.disabledReason != null) {
    return { tone: 'error', label: localize('com_ui_schedule_paused') };
  }
  if (!schedule.enabled) {
    return { tone: 'paused', label: localize('com_ui_schedule_paused') };
  }
  const lastRun = schedule.lastRun ? RUN_TONE[schedule.lastRun.status] : null;
  if (lastRun != null && lastRun.tone !== 'running') {
    return { tone: lastRun.tone, label: localize(lastRun.label) };
  }
  return { tone: 'running', label: null };
}
