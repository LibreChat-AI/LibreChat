import type { TSchedule } from 'librechat-data-provider';
import type { LocalizeFunction } from '~/common';
import { scheduleRowState } from '../state';

const localize = ((key: string) => key) as unknown as LocalizeFunction;

const schedule = (
  over: Partial<TSchedule> = {},
): Pick<TSchedule, 'enabled' | 'disabledReason' | 'lastRun'> => ({
  enabled: true,
  disabledReason: undefined,
  lastRun: undefined,
  ...over,
});

describe('scheduleRowState', () => {
  it('says nothing while the clock is in charge', () => {
    /** A running schedule's row shows when the next run lands, so a label here would
     *  take that slot and say less. */
    expect(scheduleRowState(schedule(), localize)).toEqual({ tone: 'running', label: null });
  });

  it('treats a clean last run as still running', () => {
    expect(
      scheduleRowState(
        schedule({ lastRun: { status: 'success' } } as Partial<TSchedule>),
        localize,
      ),
    ).toEqual({ tone: 'running', label: null });
  });

  it('calls a paused schedule paused', () => {
    expect(scheduleRowState(schedule({ enabled: false }), localize)).toEqual({
      tone: 'paused',
      label: 'com_ui_schedule_paused',
    });
  });

  /** The clock has stopped either way, and the reason is printed under the row, so
   *  the word stays "paused" while the marker turns to the error shape. */
  it('marks a schedule the system disabled as an error, still reading as paused', () => {
    expect(scheduleRowState(schedule({ disabledReason: 'too_many_failures' }), localize)).toEqual({
      tone: 'error',
      label: 'com_ui_schedule_paused',
    });
  });

  it('surfaces a failed run over the next one', () => {
    for (const status of ['error', 'interrupted'] as const) {
      expect(
        scheduleRowState(schedule({ lastRun: { status } } as Partial<TSchedule>), localize),
      ).toEqual({ tone: 'error', label: 'com_ui_schedule_last_run_failed' });
    }
  });

  it('surfaces a run waiting on its owner as a warning', () => {
    expect(
      scheduleRowState(
        schedule({ lastRun: { status: 'requires_action' } } as Partial<TSchedule>),
        localize,
      ),
    ).toEqual({ tone: 'warning', label: 'com_ui_schedule_needs_approval' });
  });

  /** An overlapping or in-flight run is not a problem to report: the schedule is still
   *  keeping its cadence, so the row keeps showing the next one. */
  it('leaves an overlap-skipped or started run alone', () => {
    for (const status of ['started', 'skipped_overlap'] as const) {
      expect(
        scheduleRowState(schedule({ lastRun: { status } } as Partial<TSchedule>), localize),
      ).toEqual({ tone: 'running', label: null });
    }
  });

  /** A run skipped for balance keeps the schedule enabled only until the skip count
   *  disables it, so the owner is told before the clock stops. */
  it('warns when a run was skipped for balance', () => {
    expect(
      scheduleRowState(
        schedule({ lastRun: { status: 'skipped_balance' } } as Partial<TSchedule>),
        localize,
      ),
    ).toEqual({ tone: 'warning', label: 'com_ui_schedule_run_skipped' });
  });

  /** Disabled beats everything: a schedule the system stopped is not "failing", it
   *  is not running at all. */
  it('prefers the stopped clock to whatever the last run did', () => {
    expect(
      scheduleRowState(
        schedule({
          enabled: false,
          disabledReason: 'agent_deleted',
          lastRun: { status: 'error' },
        } as Partial<TSchedule>),
        localize,
      ),
    ).toEqual({ tone: 'error', label: 'com_ui_schedule_paused' });
  });
});
