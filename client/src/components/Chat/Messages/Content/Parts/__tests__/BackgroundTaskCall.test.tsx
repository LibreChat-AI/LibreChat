import React from 'react';
import { RecoilRoot } from 'recoil';
import { fireEvent, render, screen, within } from '@testing-library/react';
import BackgroundTaskCall from '../BackgroundTaskCall';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
  useProgress: (progress: number) => progress,
  useExpandCollapse: jest.requireActual('~/hooks/Messages/useExpandCollapse').default,
  useLazyCollapseBody: jest.requireActual('~/hooks/Messages/useLazyCollapseBody').default,
}));

jest.mock('~/hooks/MCP', () => ({
  useMCPIconMap: () => new Map(),
  useMCPServerNames: () => [],
}));

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  getToolDisplayLabel: (name: string) =>
    (({ bash_tool: 'Code', web_search: 'Web Search' }) as Record<string, string>)[name] ?? name,
}));

jest.mock('../../ProgressText', () => ({
  __esModule: true,
  default: ({
    phase,
    inProgressText,
    finishedText,
    onClick,
    hasInput,
    isExpanded,
  }: {
    phase: string;
    inProgressText: string;
    finishedText: string;
    onClick: () => void;
    hasInput: boolean;
    isExpanded: boolean;
  }) => (
    <button
      type="button"
      data-testid="task-header"
      data-phase={phase}
      aria-expanded={isExpanded}
      disabled={!hasInput}
      onClick={onClick}
    >
      {phase === 'running' ? inProgressText : finishedText}
    </button>
  ),
}));

jest.mock('../../ToolOutput', () => ({
  ToolIcon: ({ type }: { type: string }) => <span data-testid="tool-icon">{type}</span>,
  getToolIconType: (name: string) => name,
  getMCPServerName: () => '',
  OutputRenderer: ({ text, copyText }: { text: string; copyText?: string }) => (
    <pre data-testid="task-output" data-copy-text={copyText}>
      {text}
    </pre>
  ),
  isError: () => false,
}));

jest.mock('../../ToolCallInfo', () => ({
  __esModule: true,
  default: ({ input, output }: { input: string; output?: string }) => (
    <div data-testid="tool-call-info" data-input={input} data-output={output} />
  ),
}));

jest.mock('../Attachment', () => ({
  AttachmentGroup: () => <div data-testid="task-attachments" />,
}));

const completed = {
  background_task_id: 'bg-1',
  tool: 'bash_tool',
  status: 'completed',
  result: 'stdout:\nchecked at=2026-09-27T00:11:09Z\n{"checks":[]}\n[exit code: 0]',
};

function renderCall(
  output: string,
  props: Partial<React.ComponentProps<typeof BackgroundTaskCall>> = {},
) {
  return render(
    <RecoilRoot>
      <BackgroundTaskCall
        args={'{"background_task_id":"bg-1"}'}
        output={output}
        isSubmitting={false}
        initialProgress={1}
        {...props}
      />
    </RecoilRoot>,
  );
}

describe('BackgroundTaskCall', () => {
  it('presents a completed code task as a native result without leaking its JSON envelope', () => {
    renderCall(JSON.stringify(completed));
    const header = screen.getByTestId('task-header');
    expect(header).toHaveTextContent('com_ui_background_tasks_checked');
    expect(header).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('task-output')).not.toBeInTheDocument();

    fireEvent.click(header);
    const card = screen.getByTestId('background-task-card');
    expect(within(card).getByText('Code')).toBeInTheDocument();
    expect(within(card).getByText('com_ui_background_tasks_completed')).toBeInTheDocument();
    expect(within(card).getByTestId('tool-icon')).toHaveTextContent('bash_tool');
    expect(within(card).getByTestId('task-output')).toHaveTextContent('checked at=2026-09-27');
    expect(within(card).getByTestId('task-output').textContent).toContain('{\n  "checks": []\n}');
    expect(within(card).getByTestId('task-output')).toHaveAttribute(
      'data-copy-text',
      completed.result,
    );
    expect(screen.getByTestId('tool-call-info')).not.toHaveAttribute('data-output');
    expect(screen.queryByText(/"background_task_id"/)).not.toBeInTheDocument();
  });

  it('renders an empty list as an empty state and warns when discovery is incomplete', () => {
    renderCall(JSON.stringify({ tasks: [], outstanding: 0, partial: true, warning: 'Try again.' }));
    expect(screen.getByTestId('task-header')).toHaveAttribute('data-phase', 'failed');
    fireEvent.click(screen.getByTestId('task-header'));
    expect(screen.getByText('com_ui_background_tasks_empty')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('com_ui_background_tasks_incomplete');
    expect(screen.queryByText('Try again.')).not.toBeInTheDocument();
  });

  it('distinguishes a running task from a finished result pending automatic delivery', () => {
    renderCall(
      JSON.stringify({
        tasks: [
          { background_task_id: 'bg-1', tool: 'web_search', status: 'running' },
          {
            background_task_id: 'bg-2',
            tool: 'bash_tool',
            status: 'completed',
            delivery: 'pending',
            result_available: true,
          },
        ],
        outstanding: 2,
      }),
      { args: '{}' },
    );
    fireEvent.click(screen.getByTestId('task-header'));
    expect(screen.getByRole('list', { name: 'com_ui_background_tasks' })).toHaveAttribute(
      'tabindex',
      '0',
    );
    const [running, pending] = screen.getAllByTestId('background-task-card');
    expect(within(running).getByText('Web Search')).toBeInTheDocument();
    expect(within(running).getByText('com_ui_background_tasks_running')).toBeInTheDocument();
    expect(within(pending).getByText('com_ui_background_tasks_result_pending')).toBeInTheDocument();
    expect(
      within(pending).getByText('com_ui_background_tasks_result_available'),
    ).toBeInTheDocument();
    expect(within(pending).queryByText('com_ui_background_tasks_no_output')).toBeNull();
  });

  it('shows an error with a failed task outcome and its actual error text', () => {
    renderCall(
      JSON.stringify({ ...completed, status: 'error', result: undefined, error: 'Disk full' }),
    );
    expect(screen.getByTestId('task-header')).toHaveAttribute('data-phase', 'failed');
    fireEvent.click(screen.getByTestId('task-header'));
    expect(screen.getByText('com_ui_failed')).toBeInTheDocument();
    expect(screen.getByText('Disk full')).toBeInTheDocument();
  });

  it('shows accepted subagent controls as queued while preserving the control id in raw details', () => {
    renderCall(
      JSON.stringify({
        background_task_id: 'bg-1',
        tool: 'subagent',
        subagent_type: 'researcher',
        status: 'accepted',
        control_id: 'control-42',
      }),
    );
    fireEvent.click(screen.getByTestId('task-header'));
    const card = screen.getByTestId('background-task-card');
    expect(within(card).getByText('com_ui_background_tasks_control_queued')).toBeInTheDocument();
    expect(within(card).getByText('researcher')).toBeInTheDocument();
    expect(within(card).queryByText('com_ui_background_tasks_completed')).toBeNull();
    expect(screen.queryByText(/control-42/)).not.toBeInTheDocument();
  });

  it('keeps an already-claimed subagent result out of the available-on-request state', () => {
    renderCall(
      JSON.stringify({
        background_task_id: 'bg-1',
        tool: 'subagent',
        subagent_type: 'researcher',
        status: 'claimed',
        result_available: true,
        result_claimed: true,
      }),
    );
    fireEvent.click(screen.getByTestId('task-header'));
    const card = screen.getByTestId('background-task-card');
    expect(within(card).getByText('com_ui_background_tasks_result_claimed')).toBeInTheDocument();
    expect(within(card).queryByText('com_ui_background_tasks_result_available')).toBeNull();
  });

  it('marks an interrupted subagent poll as failed even when the poll run step succeeded', () => {
    renderCall(
      JSON.stringify({
        background_task_id: 'bg-1',
        tool: 'subagent',
        status: 'interrupted',
        error: 'Server restarted before completion.',
      }),
      { runStepStatus: 'completed' },
    );
    expect(screen.getByTestId('task-header')).toHaveAttribute('data-phase', 'failed');
    fireEvent.click(screen.getByTestId('task-header'));
    const card = screen.getByTestId('background-task-card');
    expect(within(card).getByText('com_ui_subagent_thread_status_interrupted')).toBeInTheDocument();
    expect(within(card).getByText('Server restarted before completion.')).toBeInTheDocument();
  });

  it.each([
    ['invalid', 'com_ui_background_tasks_notice_invalid'],
    ['rejected', 'com_ui_background_tasks_notice_rejected'],
    ['unavailable', 'com_ui_background_tasks_notice_unavailable'],
    ['not_found', 'com_ui_background_tasks_notice_not_found'],
    ['outcome_unknown', 'com_ui_background_tasks_notice_outcome_unknown'],
    ['result_unavailable', 'com_ui_background_tasks_notice_result_unavailable'],
  ])(
    'announces a %s warning notice as a failed check even if the tool step succeeded',
    (status, label) => {
      const hostMessage = 'Host advice in English, for the agent only.';
      const { container } = renderCall(JSON.stringify({ status, message: hostMessage }), {
        runStepStatus: 'completed',
      });
      expect(screen.getByTestId('task-header')).toHaveAttribute('data-phase', 'failed');
      expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(label);
      fireEvent.click(screen.getByTestId('task-header'));
      expect(screen.getAllByText(label).length).toBeGreaterThan(1);
      expect(screen.queryByText(hostMessage)).not.toBeInTheDocument();
    },
  );

  it('localizes guidance without promising that a running task or pending result has finished', () => {
    const note =
      'Still running outside this turn; its result will arrive as a new turn when it finishes.';
    const message =
      'Automatic completion delivery is enabled for this subagent task. Continue independent work if available; otherwise end this turn and the host will resume you when the task finishes. Do not repeatedly poll an unchanged running task. Use check_background_task only for explicit status or control, or as a fallback if automatic delivery is unavailable.';
    renderCall(
      JSON.stringify({
        tasks: [{ background_task_id: 'bg-1', tool: 'subagent', status: 'running', note, message }],
        message,
      }),
    );
    fireEvent.click(screen.getByTestId('task-header'));
    expect(screen.getByText('com_ui_background_tasks_running_elsewhere')).toBeInTheDocument();
    expect(screen.getAllByText('com_ui_background_tasks_subagent_wakeup_guidance')).toHaveLength(2);
    expect(screen.queryByText(note)).not.toBeInTheDocument();
    expect(screen.queryByText(message)).not.toBeInTheDocument();
  });

  it('shows unknown host prose only inside raw task details, while preserving tool result text', () => {
    const note = 'Advice from a later server version.';
    const raw = JSON.stringify({
      background_task_id: 'bg-1',
      tool: 'bash_tool',
      status: 'completed',
      result: 'Tool-created output remains visible in its own language.',
      note,
    });
    renderCall(raw);
    fireEvent.click(screen.getByTestId('task-header'));
    expect(screen.getByText('com_ui_background_tasks_more_in_raw_details')).toBeInTheDocument();
    expect(
      screen.getByText('Tool-created output remains visible in its own language.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(note)).not.toBeInTheDocument();
    const details = screen.getByText('com_ui_background_tasks_raw_details').closest('details');
    if (details == null) {
      throw new Error('Task details disclosure is missing');
    }
    details.open = true;
    fireEvent(details, new Event('toggle', { bubbles: true }));
    expect(screen.getAllByTestId('task-output')).toHaveLength(2);
    expect(screen.getAllByTestId('task-output')[1]).toHaveTextContent(note);
  });

  it('shows control notices as localized text and preserves unfamiliar responses as raw output', () => {
    const { rerender } = renderCall(
      JSON.stringify({
        status: 'delivery_scheduled',
        background_task_id: 'bg-1',
        message: 'This result will arrive in a new turn.',
      }),
    );
    fireEvent.click(screen.getByTestId('task-header'));
    expect(
      screen.getAllByText('com_ui_background_tasks_notice_delivery_scheduled').length,
    ).toBeGreaterThan(1);
    expect(screen.queryByText('This result will arrive in a new turn.')).not.toBeInTheDocument();
    expect(screen.queryByTestId('tool-call-info')).not.toHaveAttribute('data-output');

    const raw = '{"status":"unexpected","result":"preserve this"}';
    rerender(
      <RecoilRoot>
        <BackgroundTaskCall args="{}" output={raw} isSubmitting={false} initialProgress={1} />
      </RecoilRoot>,
    );
    expect(screen.getByTestId('tool-call-info')).toHaveAttribute('data-output', raw);
  });

  it('reveals the exact control receipt only when raw details are opened', () => {
    const output = JSON.stringify({
      status: 'accepted',
      background_task_id: 'bg-1',
      control_id: 'control-42',
      message: 'The control request was queued.',
    });
    renderCall(output);
    fireEvent.click(screen.getByTestId('task-header'));
    expect(screen.queryByText(/control-42/)).not.toBeInTheDocument();

    const details = screen.getByText('com_ui_background_tasks_raw_details').closest('details');
    expect(details).not.toBeNull();
    if (details == null) {
      throw new Error('Task details disclosure is missing');
    }
    details.open = true;
    fireEvent(details, new Event('toggle', { bubbles: true }));
    expect(screen.getByTestId('task-output')).toHaveTextContent('control-42');
  });

  it('announces stable progress across intent deltas, then the settled intent once', () => {
    const firstArgs = '{"intent":"Checking the backgr';
    const finalArgs = '{"intent":"Checking the background task","background_task_id":"bg-1"}';
    const { container, rerender } = renderCall('', {
      args: firstArgs,
      isSubmitting: true,
      initialProgress: 0.1,
    });
    const announcement = container.querySelector('[aria-live="polite"]');
    expect(announcement).toHaveClass('sr-only');
    expect(announcement).toHaveAttribute('aria-atomic', 'true');
    expect(announcement).toHaveTextContent('com_ui_background_tasks_checking');
    rerender(
      <RecoilRoot>
        <BackgroundTaskCall args={finalArgs} output="" isSubmitting={true} initialProgress={0.1} />
      </RecoilRoot>,
    );
    expect(announcement).toHaveTextContent('com_ui_background_tasks_checking');
    rerender(
      <RecoilRoot>
        <BackgroundTaskCall
          args={finalArgs}
          output={JSON.stringify(completed)}
          isSubmitting={false}
          initialProgress={1}
          runStepStatus="completed"
        />
      </RecoilRoot>,
    );
    expect(announcement).toHaveTextContent('Checking the background task');
  });

  it.each([
    ['delivery_scheduled', 'com_ui_background_tasks_notice_delivery_scheduled'],
    ['result_persisting', 'com_ui_background_tasks_notice_result_persisting'],
  ])('announces %s as a pending state rather than a task failure', (status, label) => {
    const { container } = renderCall(
      JSON.stringify({ status, message: 'Untranslated backend status message.' }),
      { runStepStatus: 'completed' },
    );
    expect(screen.getByTestId('task-header')).toHaveAttribute('data-phase', 'completed');
    expect(screen.getByTestId('task-header')).toHaveTextContent(label);
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(label);
  });

  it.each([
    ['failed', 'com_ui_failed_subject'],
    ['cancelled', 'com_ui_cancelled'],
  ])('announces an explicit %s tool-run status ahead of benign output', (runStepStatus, label) => {
    const { container } = renderCall(
      JSON.stringify({ status: 'delivery_scheduled', message: 'The result will arrive later.' }),
      { runStepStatus: runStepStatus as 'failed' | 'cancelled' },
    );
    expect(screen.getByTestId('task-header')).toHaveAttribute('data-phase', runStepStatus);
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(label);
    expect(container.querySelector('[aria-live="polite"]')).not.toHaveTextContent(
      'com_ui_background_tasks_notice_delivery_scheduled',
    );
  });

  it('announces cancellation rather than a successful check when a result is discarded', () => {
    const { container } = renderCall(
      JSON.stringify({ status: 'cancelled', message: 'Discarded the result.' }),
      {
        runStepStatus: 'completed',
      },
    );
    expect(screen.getByTestId('task-header')).toHaveAttribute('data-phase', 'cancelled');
    expect(container.querySelector('[aria-live="polite"]')).toHaveTextContent(
      'com_ui_background_tasks_result_discarded',
    );
  });

  it('keeps the row in progress while a poll streams and updates it after settlement', () => {
    const { rerender } = renderCall('', { isSubmitting: true, initialProgress: 0.1 });
    expect(screen.getByTestId('task-header')).toHaveAttribute('data-phase', 'running');
    fireEvent.click(screen.getByTestId('task-header'));
    rerender(
      <RecoilRoot>
        <BackgroundTaskCall
          args={'{"background_task_id":"bg-1"}'}
          output={JSON.stringify(completed)}
          isSubmitting={false}
          initialProgress={1}
          runStepStatus="completed"
        />
      </RecoilRoot>,
    );
    expect(screen.getByTestId('task-header')).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('task-output')).toHaveTextContent('checked at=2026-09-27');
  });
});
