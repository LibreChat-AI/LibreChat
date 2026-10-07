import React from 'react';
import { RecoilRoot } from 'recoil';
import copy from 'copy-to-clipboard';
import { render, screen, fireEvent } from '@testing-library/react';
import { LoneGroupContext, SoleToolContext } from '../../disclosure';
import BashCall from '../BashCall';
import store from '~/store';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, values?: Record<string, string>): string => {
      const translations: Record<string, string> = {
        com_ui_command_exit_code: `exit code ${values?.[0]}`,
        com_ui_command_terminated: `terminated by ${values?.[0]}`,
        com_ui_command_timed_out: 'timed out',
        com_ui_writing_command: 'Writing command',
        com_ui_running_command: 'Running command',
        com_ui_command_finished: 'Ran command',
        com_ui_cancelled: 'Cancelled',
        com_ui_copy_code: 'Copy code',
        com_ui_background_running: 'Running in background',
        com_ui_background_finished: 'Finished in background',
        com_ui_tool_failed: 'tool failed',
        com_ui_copy: 'Copy output',
        com_ui_no_output: 'No output',
        com_ui_show_more: 'Show more',
        com_ui_show_less: 'Show less',
      };
      return translations[key] ?? key;
    },
  useProgress: (initialProgress: number) => initialProgress,
  useExpandCollapse: (isExpanded: boolean) => ({
    style: {
      display: 'grid',
      gridTemplateRows: isExpanded ? '1fr' : '0fr',
      opacity: isExpanded ? 1 : 0,
    },
    ref: { current: null },
  }),
}));

jest.mock('~/components/Chat/Messages/Content/ProgressText', () => ({
  __esModule: true,
  /** Mirrors the real component's contract: one `phase` drives both the
   *  label and the failure suffix. */
  default: ({
    phase,
    inProgressText,
    finishedText,
    verdict,
    onClick,
  }: {
    phase: 'running' | 'completed' | 'cancelled' | 'failed';
    inProgressText: string;
    finishedText: string;
    verdict?: string;
    onClick?: () => void;
  }) => (
    <div data-testid="progress-text" onClick={onClick}>
      {phase === 'running' ? inProgressText : finishedText}
      {phase === 'failed' ? ' — tool failed' : ''}
      {phase === 'failed' && verdict ? ` · ${verdict}` : ''}
    </div>
  ),
}));

jest.mock('~/components/Messages/Content/CopyButton', () => ({
  __esModule: true,
  default: ({ label, onClick }: { label?: string; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>
      {label}
    </button>
  ),
}));

jest.mock('~/components/Messages/Content/LangIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="lang-icon" />,
}));

jest.mock('../Attachment', () => ({
  AttachmentGroup: () => <div data-testid="attachment-group" />,
}));

jest.mock('../useLazyHighlight', () => {
  const { useState, useEffect } = jest.requireActual<typeof import('react')>('react');
  /** Mirrors the real hook's two-phase contract: the render that changed
   *  `code` still shows the previous highlight (or null), and the new
   *  nodes commit in a later passive effect. */
  const useMockLazyHighlight = (code?: string) => {
    const [highlighted, setHighlighted] = useState<string[] | null>(null);
    useEffect(() => {
      setHighlighted(code == null ? null : [code]);
    }, [code]);
    return highlighted;
  };
  return { __esModule: true, default: useMockLazyHighlight };
});

jest.mock('copy-to-clipboard', () => jest.fn());

jest.mock('~/utils', () => ({
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}));

const renderBashCall = (args?: string | Record<string, unknown>, commandField?: string) =>
  render(
    <RecoilRoot>
      <BashCall
        initialProgress={0.1}
        isSubmitting={true}
        args={args}
        output=""
        commandField={commandField}
      />
    </RecoilRoot>,
  );

describe('BashCall status text', () => {
  it.each([undefined, '', '{"command":"sleep 10"', '{"command":"sleep 10","timeout":'])(
    'shows "Writing command" while args are missing or incomplete: %s',
    (args) => {
      renderBashCall(args);
      expect(screen.getByTestId('progress-text')).toHaveTextContent('Writing command');
      expect(screen.queryByText('Running command')).not.toBeInTheDocument();
    },
  );

  it('keeps showing "Writing command" for partial JSON even after the command field is visible', () => {
    renderBashCall('{"command":"sleep 10","incomplete":');
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Writing command');
    expect(screen.getByText(/sleep 10/)).toBeInTheDocument();
  });

  it.each(['{"command":"sleep 10"}', { command: 'sleep 10' }])(
    'shows "Running command" once command args are complete: %s',
    (args) => {
      renderBashCall(args);
      expect(screen.getByTestId('progress-text')).toHaveTextContent('Running command');
    },
  );

  it.each(['{"code":"echo hi"}', { code: 'echo hi' }])(
    'can read bash PTC code args as the command: %s',
    (args) => {
      renderBashCall(args, 'code');
      expect(screen.getByTestId('progress-text')).toHaveTextContent('Running command');
      expect(screen.getByText(/echo hi/)).toBeInTheDocument();
    },
  );
});

describe('BashCall intent label', () => {
  it('shows a streaming intent before any other arg exists (first key, partial JSON)', () => {
    renderBashCall('{"intent":"Checking the countdown ta');
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Checking the countdown ta');
    expect(screen.queryByText('Writing command')).not.toBeInTheDocument();
  });

  it('keeps the intent as the in-progress label once the command has streamed', () => {
    renderBashCall('{"intent":"Waiting for the task to settle","command":"sleep 8; echo waited"}');
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Waiting for the task to settle');
    expect(screen.queryByText('Running command')).not.toBeInTheDocument();
    expect(screen.getByText(/sleep 8/)).toBeInTheDocument();
  });

  it('keeps the intent as the settled label (completion is a UI state, not a tense change)', () => {
    render(
      <RecoilRoot>
        <BashCall
          initialProgress={1}
          isSubmitting={false}
          args={'{"intent":"Waiting for the task to settle","command":"sleep 8"}'}
          output="waited"
        />
      </RecoilRoot>,
    );
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Waiting for the task to settle');
    expect(screen.queryByText('Ran command')).not.toBeInTheDocument();
  });

  it('falls back to the generic labels when no intent is present', () => {
    renderBashCall({ command: 'sleep 10' });
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Running command');
  });

  it('ignores a non-string intent arg (a business param, not the label contract)', () => {
    renderBashCall({ intent: { nested: true }, command: 'sleep 10' });
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Running command');
  });

  it('ignores a non-string intent in complete SERIALIZED args (no String() coercion)', () => {
    renderBashCall('{"intent":{"topic":"billing"},"command":"sleep 10"}');
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Running command');
    expect(screen.queryByText(/object Object/)).not.toBeInTheDocument();
  });

  it('ignores an intent that is not the FIRST args key (label contract is first-position)', () => {
    renderBashCall('{"command":"sleep 10","intent":"billing_inquiry"}');
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Running command');
    expect(screen.queryByText('billing_inquiry')).not.toBeInTheDocument();
  });

  it('bounds a runaway intent to a single 256-char line', () => {
    const runaway = `Checking ${'a very long clause '.repeat(30)}end`;
    renderBashCall({ intent: runaway, command: 'sleep 10' });
    const text = screen.getByTestId('progress-text').textContent ?? '';
    expect(text.length).toBeLessThanOrEqual(256);
    expect(text.endsWith('…')).toBe(true);
  });

  it('never splits a surrogate pair at the truncation boundary', () => {
    const straddling = `${'x'.repeat(254)}😀 and more text to exceed the bound`;
    renderBashCall({ intent: straddling, command: 'sleep 10' });
    const text = screen.getByTestId('progress-text').textContent ?? '';
    expect(text.endsWith('x…')).toBe(true);
    expect(text).not.toContain('�');
  });

  it('decodes unicode escapes in a streaming intent (no literal \\uXXXX flash)', () => {
    renderBashCall('{"intent":"Checking caf\\u00e9 menu da');
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Checking café menu da');
  });

  it('keeps a terminal lone high surrogate once the value is settled (matches JSON.parse)', () => {
    renderBashCall('{"intent":"odd \\ud83d","command":"sleep 10"}');
    const text = screen.getByTestId('progress-text').textContent ?? '';
    expect(text).toBe('odd \ud83d');
  });
});

describe('BashCall backgrounded calls', () => {
  const HANDLE_OUTPUT = JSON.stringify({
    background_task_id: 'task-1',
    tool: 'bash_tool',
    status: 'running',
    message:
      'Started "bash_tool" in the background. Call check_background_task with background_task_id "task-1" to check progress and retrieve the result.',
  });

  const renderBackgrounded = (attachments?: Array<Record<string, unknown>>) =>
    render(
      <RecoilRoot>
        <BashCall
          initialProgress={1}
          isSubmitting={false}
          args={{ command: 'sleep 600' }}
          output={HANDLE_OUTPUT}
          attachments={attachments as never}
        />
      </RecoilRoot>,
    );

  it('shows a background-running state instead of rendering the handle JSON as stdout', () => {
    renderBackgrounded();
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Running in background');
    expect(screen.queryByText(/background_task_id/)).not.toBeInTheDocument();
  });

  it('flips to finished once attachments arrive for the call', () => {
    renderBackgrounded([{ file_id: 'f1' }]);
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Finished in background');
  });

  it('flips to finished on the status marker alone (stdout-only completion)', () => {
    renderBackgrounded([
      { type: 'background_task_status', file_id: 'bg-tc-1', toolCallId: 'tc-1' },
    ]);
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Finished in background');
    expect(screen.queryByTestId('attachment-group')).not.toBeInTheDocument();
  });

  it('surfaces failure when the marker carries an error status', () => {
    renderBackgrounded([
      { type: 'background_task_status', file_id: 'bg-tc-1', toolCallId: 'tc-1', status: 'error' },
    ]);
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Finished in background');
    expect(screen.getByTestId('progress-text')).toHaveTextContent('tool failed');
  });

  it('surfaces a live cancelled marker as cancellation rather than failure', () => {
    renderBackgrounded([
      {
        type: 'background_task_status',
        file_id: 'bg-tc-1',
        toolCallId: 'tc-1',
        status: 'cancelled',
      },
    ]);
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Cancelled');
    expect(screen.getByTestId('progress-text')).not.toHaveTextContent('tool failed');
  });

  it('restores a persisted background cancellation as cancellation', () => {
    render(
      <RecoilRoot>
        <BashCall
          initialProgress={1}
          isSubmitting={false}
          args={{ command: 'sleep 600' }}
          output="Error: [bash_tool] tool call failed: Background task cancellation requested"
          backgrounded={true}
          backgroundCancelled={true}
        />
      </RecoilRoot>,
    );
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Cancelled');
    expect(screen.getByTestId('progress-text')).not.toHaveTextContent('tool failed');
  });

  it('renders real stdout normally after the background result patches the output', () => {
    render(
      <RecoilRoot>
        <BashCall
          initialProgress={1}
          isSubmitting={false}
          args={{ command: 'echo hi' }}
          output="hi"
        />
      </RecoilRoot>,
    );
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Ran command');
    expect(screen.getByText('hi')).toBeInTheDocument();
  });
});

describe('BashCall sole tool disclosure', () => {
  const renderCall = (soleTool: boolean) =>
    render(
      <RecoilRoot>
        <SoleToolContext.Provider value={soleTool}>
          <BashCall
            initialProgress={1}
            isSubmitting={false}
            args={{ command: 'echo hi' }}
            output="hi"
          />
        </SoleToolContext.Provider>
      </RecoilRoot>,
    );
  const panel = (container: HTMLElement) =>
    container.querySelector('[style*="grid-template-rows"]') as HTMLElement;

  it('opens the card when it is the only call, with autoExpandTools off', () => {
    const { container } = renderCall(true);
    expect(panel(container).style.gridTemplateRows).toBe('1fr');
  });

  it('keeps the card collapsed when it is one of several calls', () => {
    const { container } = renderCall(false);
    expect(panel(container).style.gridTemplateRows).toBe('0fr');
  });

  it('drops its own row when it is the only call, so the output follows the group header', () => {
    renderCall(true);
    expect(screen.queryByTestId('progress-text')).not.toBeInTheDocument();
    expect(screen.getByText('hi')).toBeInTheDocument();
  });

  it('keeps its row when it is one of several calls', () => {
    renderCall(false);
    expect(screen.getByTestId('progress-text')).toBeInTheDocument();
  });

  it('keeps its row when the call carries a model-authored intent', () => {
    render(
      <RecoilRoot>
        <SoleToolContext.Provider value>
          <BashCall
            initialProgress={1}
            isSubmitting={false}
            args={{ intent: 'Check the build', command: 'echo hi' }}
            output="hi"
            runStepStatus="completed"
          />
        </SoleToolContext.Provider>
      </RecoilRoot>,
    );
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Check the build');
  });

  it('drops its row when its group holds one call inside a phase of several', () => {
    render(
      <RecoilRoot>
        <SoleToolContext.Provider value={false}>
          <LoneGroupContext.Provider value>
            <BashCall
              initialProgress={1}
              isSubmitting={false}
              args={{ command: 'echo hi' }}
              output="hi"
              runStepStatus="completed"
            />
          </LoneGroupContext.Provider>
        </SoleToolContext.Provider>
      </RecoilRoot>,
    );
    expect(screen.queryByTestId('progress-text')).not.toBeInTheDocument();
    expect(screen.getByText('hi')).toBeInTheDocument();
  });

  it('keeps its row while the only call is still running', () => {
    render(
      <RecoilRoot>
        <SoleToolContext.Provider value>
          <BashCall initialProgress={0.5} isSubmitting args={{ command: 'sleep 5' }} output="" />
        </SoleToolContext.Provider>
      </RecoilRoot>,
    );
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Running command');
  });

  it('keeps its row when the only call failed, so the failure stays reachable', () => {
    render(
      <RecoilRoot>
        <SoleToolContext.Provider value>
          <BashCall
            initialProgress={1}
            isSubmitting={false}
            executor="attached_workspace"
            args={{ command: 'false' }}
            output={'stderr:\nboom\n\n[exit code: 1]'}
          />
        </SoleToolContext.Provider>
      </RecoilRoot>,
    );
    expect(screen.getByTestId('progress-text')).toHaveTextContent('tool failed');
  });

  it('keeps its row for a detached task whose dispatch step has closed', () => {
    const handle = JSON.stringify({
      background_task_id: 'task-1',
      tool: 'bash_tool',
      status: 'running',
      message: 'Use check_background_task to follow it',
    });
    render(
      <RecoilRoot>
        <SoleToolContext.Provider value>
          <BashCall
            initialProgress={1}
            isSubmitting={false}
            args={{ command: 'sleep 600' }}
            output={handle}
          />
        </SoleToolContext.Provider>
      </RecoilRoot>,
    );
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Running in background');
  });

  it('closes the card again when its group gains a second call', () => {
    const { container, rerender } = renderCall(true);
    expect(panel(container).style.gridTemplateRows).toBe('1fr');
    rerender(
      <RecoilRoot>
        <SoleToolContext.Provider value={false}>
          <BashCall
            initialProgress={1}
            isSubmitting={false}
            args={{ command: 'echo hi' }}
            output="hi"
          />
        </SoleToolContext.Provider>
      </RecoilRoot>,
    );
    expect(panel(container).style.gridTemplateRows).toBe('0fr');
  });
});

/**
 * jsdom has no layout, so the capped pane's scroll geometry is stubbed:
 * `clientHeight` is fixed, `scrollHeight` either reads from mutable state
 * or derives from the pane's rendered text (so the async highlight commit
 * measurably changes it), and every `scrollTop` write the component makes
 * is recorded. Direct mutations of the returned state bypass the element
 * setter, so `writes` only ever contains scrolls the component performed.
 */
const mockScrollMetrics = (
  el: HTMLElement,
  clientHeight: number,
  opts: { deriveHeightFromText?: boolean } = {},
) => {
  const state = { scrollHeight: 0, scrollTop: 0, writes: [] as number[] };
  Object.defineProperty(el, 'scrollHeight', {
    configurable: true,
    get: () =>
      opts.deriveHeightFromText === true ? (el.textContent?.length ?? 0) * 10 : state.scrollHeight,
  });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => state.scrollTop,
    set: (value: number) => {
      state.scrollTop = value;
      state.writes.push(value);
    },
  });
  return state;
};

describe('BashCall streaming follow-scroll', () => {
  const streamingArgs = (command: string) => `{"command":"${command}`;

  /** `autoExpandTools` opens the pane at mount, mirroring the user who
   *  watches args stream into an expanded card. */
  const streamingCall = (command: string) => (
    <RecoilRoot initializeState={({ set }) => set(store.autoExpandTools, true)}>
      <BashCall initialProgress={0.1} isSubmitting={true} args={streamingArgs(command)} output="" />
    </RecoilRoot>
  );

  it('pins the expanded box to the args as rendered, including the async highlight commit', () => {
    const { container, rerender } = render(streamingCall('echo start'));
    const box = container.querySelector('.overflow-auto') as HTMLElement;
    const state = mockScrollMetrics(box, 300, { deriveHeightFromText: true });

    rerender(streamingCall('echo start && echo a second streamed line'));

    expect(box.textContent).toContain('echo a second streamed line');
    expect(state.scrollTop).toBe((box.textContent?.length ?? 0) * 10);
  });

  it('stops following when the user scrolls up to read, and resumes once they return to the bottom', () => {
    const { container, rerender } = render(streamingCall('echo start'));
    const box = container.querySelector('.overflow-auto') as HTMLElement;
    const state = mockScrollMetrics(box, 300);
    state.scrollHeight = 900;

    state.scrollTop = 100;
    fireEvent.scroll(box);
    rerender(streamingCall('echo start && echo second'));
    expect(state.writes).toHaveLength(0);

    state.scrollTop = 580;
    fireEvent.scroll(box);
    rerender(streamingCall('echo start && echo second && echo third'));
    expect(state.writes).toEqual([900]);
  });

  it('leaves a collapsed pane alone while args stream (default autoExpandTools)', () => {
    const collapsedCall = (command: string) => (
      <RecoilRoot>
        <BashCall
          initialProgress={0.1}
          isSubmitting={true}
          args={streamingArgs(command)}
          output=""
        />
      </RecoilRoot>
    );
    const { container, rerender } = render(collapsedCall('echo start'));
    const box = container.querySelector('.overflow-auto') as HTMLElement;
    const state = mockScrollMetrics(box, 300);
    state.scrollHeight = 900;

    rerender(collapsedCall('echo start && echo a second streamed line'));

    expect(state.writes).toHaveLength(0);
  });

  it('never scrolls a finished call', () => {
    const finishedCall = (command: string) => (
      <RecoilRoot initializeState={({ set }) => set(store.autoExpandTools, true)}>
        <BashCall initialProgress={1} isSubmitting={false} args={{ command }} output="done" />
      </RecoilRoot>
    );
    const { container, rerender } = render(finishedCall('echo done'));
    const box = container.querySelector('.overflow-auto') as HTMLElement;
    const state = mockScrollMetrics(box, 300);
    state.scrollHeight = 900;

    rerender(finishedCall('echo done && echo a longer settled command'));

    expect(state.writes).toHaveLength(0);
  });
});

describe('BashCall output pane', () => {
  const finished = (output: string, command = 'npm test') =>
    render(
      <RecoilRoot>
        <BashCall initialProgress={1} isSubmitting={false} args={{ command }} output={output} />
      </RecoilRoot>,
    );

  const numbered = (count: number) =>
    Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

  it('shows long output in full with no show more toggle', () => {
    finished(numbered(40));
    expect(screen.getByText(/line 40/).textContent).toBe(numbered(40));
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument();
  });

  it('keeps leading whitespace and blank lines verbatim', () => {
    const output = '\n  indented\n\n    deeper';
    finished(output);
    expect(screen.getByText(/indented/).textContent).toBe(output);
  });

  it('copies the raw output', () => {
    const output = 'ok 1\nok 2\n';
    finished(output);
    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    expect(copy).toHaveBeenCalledWith(output, { format: 'text/plain' });
  });

  it('renders JSON stdout verbatim instead of reformatting it', () => {
    finished('{"a":1}');
    expect(screen.getByText('{"a":1}')).toBeInTheDocument();
  });

  it.each([
    "stdout: Empty. Ensure you're writing output explicitly.\n",
    "  stdout: Empty. Ensure you're writing output explicitly.  ",
  ])('shows a "No output" state for the sandbox empty-stdout notice: %j', (output) => {
    finished(output, 'true');
    expect(screen.getByText('No output')).toBeInTheDocument();
    expect(screen.queryByText(/Ensure you're writing output/)).not.toBeInTheDocument();
  });

  it('keeps the notice when it is not the entire output', () => {
    finished("stdout: Empty. Ensure you're writing output explicitly.\nstderr: boom");
    expect(screen.queryByText('No output')).not.toBeInTheDocument();
    expect(screen.getByText(/stderr: boom/)).toBeInTheDocument();
  });

  it('keeps error colouring for failing output', () => {
    finished('Traceback (most recent call last):\n  File "x.py"\nValueError: bad');
    expect(screen.getByText(/ValueError: bad/)).toHaveClass('text-status-error');
  });

  it('uses the primary text colour for ordinary output', () => {
    finished('all good');
    const pre = screen.getByText('all good');
    expect(pre).toHaveClass('text-text-primary');
    expect(pre).not.toHaveClass('text-status-error');
  });

  it('lets the command wrap at the prompt size despite the global hljs rule', () => {
    const { container } = finished('done', 'echo a-very-long-command');
    const code = container.querySelector('code.hljs') as HTMLElement;
    expect(code).toHaveClass('!text-xs', '!whitespace-pre-wrap', '!break-words');
  });
});

describe('BashCall exit status', () => {
  const renderSettled = (output: string, attached = true) =>
    render(
      <RecoilRoot>
        <BashCall
          initialProgress={1}
          isSubmitting={false}
          runStepStatus="completed"
          args={{ command: 'make test' }}
          output={output}
          executor={attached ? 'attached_workspace' : undefined}
        />
      </RecoilRoot>,
    );

  it('does not read a trailer the sandbox command printed itself', () => {
    const { container } = renderSettled('stdout:\n[exit code: 1]', false);
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Ran command');
    expect(screen.getByTestId('progress-text')).not.toHaveTextContent('tool failed');
    expect(container.querySelectorAll('pre')[1]).toHaveTextContent('[exit code: 1]');
  });

  it('fails the same output when the server marked it attached-workspace', () => {
    renderSettled('stdout:\n[exit code: 1]');
    expect(screen.getByTestId('progress-text')).toHaveTextContent(/tool failed · exit code 1$/);
  });

  it('fails a non-zero exit even when the output matches no error pattern', () => {
    renderSettled('stdout:\n1 test failed\n\n[exit code: 2]');
    expect(screen.getByTestId('progress-text')).toHaveTextContent(/tool failed · exit code 2$/);
  });

  it('keeps a zero exit successful even when stderr reads like an error', () => {
    const { container } = renderSettled(
      'stdout:\nok\n\nstderr:\nError: deprecated flag\n\n[exit code: 0]',
    );
    expect(screen.getByTestId('progress-text')).toHaveTextContent('Ran command');
    expect(screen.getByTestId('progress-text')).not.toHaveTextContent('tool failed');
    const stderr = screen.getByText(/deprecated flag/);
    expect(stderr).toHaveClass('text-text-secondary');
    expect(container.querySelectorAll('pre')[1]).toHaveClass('text-text-primary');
    expect(container.querySelectorAll('pre')[1]).toHaveTextContent('stdout: ok');
  });

  it('marks stderr as an error on a failed run', () => {
    renderSettled('stderr:\nboom\n\n[exit code: 1]');
    expect(screen.getByText(/boom/)).toHaveClass('text-status-error');
  });

  it.each([
    ['stdout:\nsleeping\n\n[terminated by SIGKILL][timed out]', 'timed out'],
    ['Command completed with no output.\n[terminated by SIGTERM]', 'terminated by SIGTERM'],
  ])('names the reason for a stopped command: %s', (output, reason) => {
    renderSettled(output);
    expect(screen.getByTestId('progress-text')).toHaveTextContent(`tool failed · ${reason}`);
  });

  it('keeps the text heuristic for sandbox output without an exit trailer', () => {
    const { container } = renderSettled('stdout:\nTraceback (most recent call last)\n', false);
    expect(screen.getByTestId('progress-text')).not.toHaveTextContent('tool failed');
    expect(container.querySelectorAll('pre')[1]).toHaveClass('text-status-error');
  });
});
