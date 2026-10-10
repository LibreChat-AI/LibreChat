import {
  backgroundListGuidanceKeys,
  backgroundTaskMessageKey,
  backgroundTaskNoteKey,
  backgroundTaskNoticeKey,
} from '../guidance';
import { parseBackgroundTaskOutput } from '../background';

describe('background task host guidance', () => {
  it.each([
    [
      'Generated files were saved and attached to the tool call that dispatched this task.',
      'com_ui_background_tasks_files_attached',
    ],
    [
      'Output and any generated files are being attached to the tool call that dispatched this task.',
      'com_ui_background_tasks_files_attaching',
    ],
    [
      'The tool produced an artifact that is not included inline.',
      'com_ui_background_tasks_artifact_not_inline',
    ],
    [
      'Still running outside this turn; its result will arrive as a new turn when it finishes.',
      'com_ui_background_tasks_running_elsewhere',
    ],
    [
      'Finished, but its result has not been delivered; it will arrive as a new turn unless you poll or cancel it.',
      'com_ui_background_tasks_pending_delivery_note',
    ],
    [
      'Automatic delivery failed; this result will not arrive as a new turn. Poll it to collect the result.',
      'com_ui_background_tasks_failed_delivery_note',
    ],
  ])('localizes known task note variants: %s', (note, expected) => {
    expect(backgroundTaskNoteKey(note)).toBe(expected);
  });

  it('keeps unknown host notes and messages behind raw details', () => {
    expect(backgroundTaskNoteKey('New server-side note with context.')).toBe(
      'com_ui_background_tasks_more_in_raw_details',
    );
    expect(backgroundTaskMessageKey('New server-side control advice.')).toBe(
      'com_ui_background_tasks_more_in_raw_details',
    );
    expect(backgroundTaskNoteKey('constructor')).toBe(
      'com_ui_background_tasks_more_in_raw_details',
    );
    expect(backgroundTaskMessageKey('__proto__')).toBe(
      'com_ui_background_tasks_more_in_raw_details',
    );
    expect(backgroundTaskNoticeKey('constructor', 'Unexpected status.')).toBe(
      'com_ui_background_tasks_more_in_raw_details',
    );
  });

  it('localizes known task messages without losing the cancellation and automatic-delivery rules', () => {
    expect(
      backgroundTaskMessageKey(
        'Cancellation was requested. The task remains active until its executor settles; poll again for a terminal result.',
      ),
    ).toBe('com_ui_background_tasks_cancellation_requested');
    expect(
      backgroundTaskMessageKey(
        'Automatic completion delivery is enabled for this subagent task. Continue independent work if available; otherwise end this turn and the host will resume you when the task finishes. Do not repeatedly poll an unchanged running task. Use check_background_task only for explicit status or control, or as a fallback if automatic delivery is unavailable.',
      ),
    ).toBe('com_ui_background_tasks_subagent_wakeup_guidance');
    expect(
      backgroundTaskMessageKey(
        'This subagent resumes you automatically when it finishes, so there is no need to check again. If you do, wait next_check_s and pass since: activity.cursor.',
      ),
    ).toBe('com_ui_background_tasks_subagent_wakeup_guidance');
    expect(
      backgroundTaskMessageKey(
        'Results are not pushed for this subagent. Check again after next_check_s, passing since: activity.cursor to get only new activity.',
      ),
    ).toBe('com_ui_background_tasks_subagent_poll_guidance');
  });

  it.each([
    ['invalid', 'Wrong arguments.', 'com_ui_background_tasks_notice_invalid'],
    ['rejected', 'Capacity reached.', 'com_ui_background_tasks_notice_rejected'],
    ['not_found', 'No task here.', 'com_ui_background_tasks_notice_not_found'],
    [
      'outcome_unknown',
      'Unable to confirm result.',
      'com_ui_background_tasks_notice_outcome_unknown',
    ],
    [
      'result_unavailable',
      'Receipt temporarily unavailable.',
      'com_ui_background_tasks_notice_result_unavailable',
    ],
    [
      'result_persisting',
      'Receipt is settling.',
      'com_ui_background_tasks_notice_result_persisting',
    ],
    [
      'delivery_scheduled',
      'Assigned to another poll.',
      'com_ui_background_tasks_notice_delivery_scheduled',
    ],
    ['unavailable', 'Process disconnected.', 'com_ui_background_tasks_notice_unavailable'],
    ['cancelled', 'Result discarded.', 'com_ui_background_tasks_result_discarded'],
  ])('gives %s a localized, conservative notice', (status, message, expected) => {
    expect(backgroundTaskNoticeKey(status, message)).toBe(expected);
  });

  it('distinguishes disabled cancellation, unsupported controls, and a failed discard', () => {
    expect(
      backgroundTaskNoticeKey(
        'invalid',
        'Cancellation is not enabled for ordinary background tools.',
      ),
    ).toBe('com_ui_background_tasks_cancel_disabled');
    expect(
      backgroundTaskNoticeKey(
        'invalid',
        'This control action is supported only for subagent tasks.',
      ),
    ).toBe('com_ui_background_tasks_notice_subagent_only');
    expect(
      backgroundTaskNoticeKey(
        'unavailable',
        'The pending result could not be discarded right now. It may still arrive as a new turn; retry the cancel shortly.',
      ),
    ).toBe('com_ui_background_tasks_notice_discard_unavailable');
    expect(backgroundTaskNoticeKey('new_status', 'Unexpected server advice.')).toBe(
      'com_ui_background_tasks_more_in_raw_details',
    );
  });

  it('summarizes pending and failed delivery from task status, not backend English', () => {
    const display = parseBackgroundTaskOutput(
      JSON.stringify({
        tasks: [
          {
            background_task_id: 'ordinary-pending',
            tool: 'bash_tool',
            status: 'completed',
            delivery: 'pending',
          },
          {
            background_task_id: 'ordinary-failed',
            tool: 'read_file',
            status: 'completed',
            delivery: 'failed',
          },
          {
            background_task_id: 'subagent-pending',
            tool: 'subagent',
            status: 'error',
            delivery: 'pending',
          },
          { background_task_id: 'subagent-running', tool: 'subagent', status: 'running' },
        ],
        message:
          'Some other text. Automatic completion delivery is enabled for this subagent task.',
      }),
    );
    if (display?.kind !== 'list') {
      throw new Error('Expected a task list');
    }
    expect(backgroundListGuidanceKeys(display)).toEqual([
      'com_ui_background_tasks_pending_delivery_guidance',
      'com_ui_background_tasks_failed_delivery_guidance',
      'com_ui_background_tasks_subagent_pending_guidance',
      'com_ui_background_tasks_subagent_wakeup_guidance',
    ]);
  });

  it('never promises automatic delivery for a running subagent without host guidance', () => {
    const display = parseBackgroundTaskOutput(
      JSON.stringify({
        tasks: [{ background_task_id: 'subagent', tool: 'subagent', status: 'running' }],
        message: 'Poll for results manually.',
      }),
    );
    if (display?.kind !== 'list') {
      throw new Error('Expected a task list');
    }
    expect(backgroundListGuidanceKeys(display)).toEqual([
      'com_ui_background_tasks_more_in_raw_details',
    ]);
  });
});
