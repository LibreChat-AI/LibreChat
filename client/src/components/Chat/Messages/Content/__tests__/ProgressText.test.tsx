import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { FailedRevealContext } from '../reveal';
import ProgressText from '../ProgressText';

jest.mock('~/hooks', () => ({
  useLocalize:
    () =>
    (key: string, values?: Record<string, string | number>): string => {
      const translations: Record<string, string> = {
        com_ui_duration_seconds: `${values?.[0]}s`,
        com_ui_tool_preparation_time: 'Preparation',
        com_ui_tool_call_time: 'Tool call',
        com_ui_tool_total_time: 'Total elapsed',
        com_ui_duration_minutes: `${values?.[0]}m ${values?.[1]}s`,
        com_ui_duration_announced_seconds: `took ${values?.count} seconds`,
        com_ui_duration_announced_seconds_one: `took ${values?.count} second`,
        com_ui_duration_announced_minutes: `took ${values?.count} minutes`,
        com_ui_duration_announced_minutes_one: `took ${values?.count} minute`,
      };
      return translations[key] ?? key;
    },
}));

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ i18n: { language: 'en' } }),
}));

jest.mock('../CancelledIcon', () => ({
  __esModule: true,
  default: () => <span data-testid="cancelled-icon" />,
}));

const defaults = {
  phase: 'completed' as const,
  inProgressText: 'Running foo',
  finishedText: 'Completed foo',
};

const renderProgressText = (props: Partial<React.ComponentProps<typeof ProgressText>> = {}) =>
  render(<ProgressText {...defaults} {...props} />);

describe('ProgressText duration', () => {
  it('renders the compact duration on a settled card', () => {
    renderProgressText({ durationMs: 3500 });
    expect(screen.getByText('· Total elapsed 3.5s')).toBeInTheDocument();
  });

  it('shows separate preparation and tool intervals without using the total as execution time', () => {
    renderProgressText({
      durationMs: 248_000,
      toolPreparationDurationMs: 242_000,
      toolExecutionDurationMs: 5_700,
    });
    expect(screen.getByText('· Preparation 4m 2s')).toBeInTheDocument();
    expect(screen.getByText('· Tool call 5.7s')).toBeInTheDocument();
    expect(screen.queryByText(/Total elapsed/)).not.toBeInTheDocument();
  });

  it('shows a few-hundred-millisecond tool call beside minutes of preparation', () => {
    renderProgressText({
      durationMs: 247_340,
      toolPreparationDurationMs: 247_000,
      toolExecutionDurationMs: 340,
    });
    expect(screen.getByText('· Preparation 4m 7s')).toBeInTheDocument();
    expect(screen.getByText('· Tool call 0.3s')).toBeInTheDocument();
    expect(screen.queryByText(/Total elapsed/)).not.toBeInTheDocument();
  });

  it('does not show a measured call too short to format as a nonzero interval', () => {
    renderProgressText({ toolExecutionDurationMs: 40 });
    expect(screen.queryByText(/Tool call/)).not.toBeInTheDocument();
  });

  it('formats durations of a minute or more as minutes and seconds', () => {
    renderProgressText({ durationMs: 65_000 });
    expect(screen.getByText('· Total elapsed 1m 5s')).toBeInTheDocument();
  });

  /**
   * The number would be stale the moment it rendered, and the label beside it
   * is still the in-progress one.
   */
  it('starts each phase timer on the browser clock, not on a skewed server stamp', () => {
    const clock = jest.spyOn(Date, 'now').mockReturnValue(20_000);
    const { rerender } = renderProgressText({ phase: 'running', phaseStartAt: 1_000 });
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent('0s');
    clock.mockReturnValue(24_000);
    rerender(<ProgressText {...defaults} phase="running" phaseStartAt={2_000} />);
    expect(screen.getByTestId('stream-elapsed')).toHaveTextContent('0s');
    clock.mockRestore();
  });

  it('does not render while the step is still running', () => {
    renderProgressText({ phase: 'running', durationMs: 3500 });
    expect(screen.queryByText('· Total elapsed 3.5s')).not.toBeInTheDocument();
  });

  /**
   * On a cancelled or failed card the slot already carries the cancelled icon
   * or the failure suffix, and "how long it took" is not the fact the reader
   * needs. Both terminal-failure states are pinned: they used to arrive
   * through two different props (`error` for cancellation, `errorSuffix` for
   * failure), and gating on one of them alone rendered a duration beside
   * "failed" (Codex round 1 on #14892). They are now one value.
   */
  it('does not render on a cancelled card', () => {
    renderProgressText({ phase: 'cancelled', durationMs: 3500 });
    expect(screen.queryByText('· Total elapsed 3.5s')).not.toBeInTheDocument();
  });

  it('does not render on a failed card', () => {
    renderProgressText({ phase: 'failed', durationMs: 3500 });
    expect(screen.queryByText('· Total elapsed 3.5s')).not.toBeInTheDocument();
    expect(screen.queryByText('Total elapsed took 3.5 seconds')).not.toBeInTheDocument();
  });

  it('renders nothing when no duration was derivable', () => {
    renderProgressText({});
    expect(screen.queryByText(/took/)).not.toBeInTheDocument();
  });

  /** Sub-threshold durations are noise; the gate lives in the shared helper. */
  it('suppresses a duration too short to be worth reporting', () => {
    renderProgressText({ durationMs: 300 });
    expect(screen.queryByText('· Total elapsed 0.3s')).not.toBeInTheDocument();
  });

  describe('accessibility', () => {
    it('hides the compact form from assistive technology and pairs it with a spoken one', () => {
      renderProgressText({ durationMs: 3500 });
      expect(screen.getByText('· Total elapsed 3.5s')).toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByText('Total elapsed took 3.5 seconds')).toHaveClass('sr-only');
    });

    it('announces the singular form for exactly one second', () => {
      renderProgressText({ durationMs: 1000 });
      expect(screen.getByText('Total elapsed took 1 second')).toBeInTheDocument();
    });

    it('announces whole minutes for longer steps', () => {
      renderProgressText({ durationMs: 150_000 });
      expect(screen.getByText('Total elapsed took 3 minutes')).toBeInTheDocument();
    });

    /** Both spans sit inside the button, so its accessible name carries the
     *  duration without an `aria-live` region re-announcing it. */
    it('keeps the duration inside the button', () => {
      renderProgressText({ durationMs: 3500 });
      expect(screen.getByRole('button')).toHaveTextContent('Total elapsed took 3.5 seconds');
    });
  });
});

describe('ProgressText disclosure', () => {
  it('shows an expandable chevron only on hover or focus', () => {
    const onClick = jest.fn();
    renderProgressText({ hasInput: true, onClick });

    const button = screen.getByRole('button', { name: 'Completed foo' });
    const chevron = button.querySelector('svg');

    expect(button).toHaveClass('group/disclosure');
    expect(chevron).toHaveClass(
      'opacity-0',
      'group-hover/disclosure:opacity-100',
      'group-focus-within/disclosure:opacity-100',
    );
    expect(chevron).toHaveClass('transition-transform');
    expect(chevron?.getAttribute('class')).not.toContain('transition-opacity');

    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('renders no chevron or disclosure state without expandable content', () => {
    renderProgressText({ hasInput: false });

    const button = screen.getByRole('button', { name: 'Completed foo' });

    expect(button).toBeDisabled();
    expect(button).not.toHaveAttribute('aria-expanded');
    expect(button.querySelector('svg')).toBeNull();
  });
});

describe('ProgressText subtitle', () => {
  it('gives the subtitle every bit of the shrink so the label keeps its last letters', () => {
    renderProgressText({ subtitle: 'HTTP 429 from github.com' });
    const label = screen.getByText('Completed foo');
    const subtitle = screen.getByText('HTTP 429 from github.com');
    expect(label).toHaveClass('shrink-0', 'max-w-full', 'truncate');
    expect(subtitle).toHaveClass('shrink', 'min-w-0', 'truncate');
  });

  it('lets a lone label shrink into its own ellipsis', () => {
    renderProgressText();
    expect(screen.getByText('Completed foo')).not.toHaveClass('shrink-0');
  });
});

describe('ProgressText failure', () => {
  it('keeps the verdict word on a failed row, open or not', () => {
    renderProgressText({ phase: 'failed', hasInput: true, isExpanded: true });
    expect(screen.getByText('· com_ui_tool_failed')).toBeInTheDocument();
  });

  it('marks a failed row at its left edge and nothing else', () => {
    const { container, rerender } = renderProgressText({ phase: 'failed' });
    expect(container.querySelector('.progress-text-wrapper')).toHaveClass('before:bg-status-error');
    rerender(<ProgressText {...defaults} phase="completed" />);
    expect(container.querySelector('.progress-text-wrapper')).not.toHaveClass(
      'before:bg-status-error',
    );
  });
});

describe('ProgressText failed reveal', () => {
  const reveal = (tick: number, claim = true) => ({ tick, claimFocus: () => claim });
  let onClick: jest.Mock;
  beforeEach(() => {
    onClick = jest.fn();
  });
  const tree = (value: { tick: number; claimFocus: () => boolean }, props = {}) => (
    <FailedRevealContext.Provider value={value}>
      <ProgressText {...defaults} phase="failed" onClick={onClick} {...props} />
    </FailedRevealContext.Provider>
  );

  it('opens through its own toggle and takes focus on the labeled button', () => {
    const { rerender } = render(tree(reveal(0)));
    expect(onClick).not.toHaveBeenCalled();
    rerender(tree(reveal(1)));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button')).toHaveFocus();
  });

  it('opens but leaves focus alone when another row already claimed it', () => {
    const { rerender } = render(tree(reveal(0, false)));
    rerender(tree(reveal(1, false)));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button')).not.toHaveFocus();
  });

  it('does not toggle a panel that is already open', () => {
    const { rerender } = render(tree(reveal(0), { isExpanded: true }));
    rerender(tree(reveal(1), { isExpanded: true }));
    expect(onClick).not.toHaveBeenCalled();
    expect(screen.getByRole('button')).toHaveFocus();
  });

  it('ignores the request on a row that did not fail or cannot open', () => {
    const pair = (tick: number) => (
      <FailedRevealContext.Provider value={reveal(tick)}>
        <ProgressText {...defaults} phase="completed" onClick={onClick} />
        <ProgressText {...defaults} phase="failed" hasInput={false} onClick={onClick} />
      </FailedRevealContext.Provider>
    );
    const { rerender } = render(pair(0));
    rerender(pair(1));
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe('ProgressText fixed siblings', () => {
  it('keeps the verdict, duration and chevron out of the shrinking label box', () => {
    const { container } = renderProgressText({
      phase: 'completed',
      subtitle: 'a very long subtitle',
      durationMs: 3500,
    });
    const box = screen.getByText('Completed foo').parentElement;
    expect(box).toHaveClass('min-w-0');
    expect(box).toContainElement(screen.getByText('a very long subtitle'));
    expect(screen.getByText('· Total elapsed 3.5s').parentElement).toHaveClass('shrink-0');
    expect(container.querySelector('svg')).toHaveClass('shrink-0');
  });
});

describe('ProgressText verdict', () => {
  it('names the failure reason inside the button on a failed card', () => {
    renderProgressText({ phase: 'failed', verdict: 'exit code 2' });
    expect(screen.getByRole('button')).toHaveTextContent('· com_ui_tool_failed· exit code 2');
  });

  it('keeps the failure verdict but hides preparation, call, total, and live timers', () => {
    renderProgressText({
      phase: 'failed',
      verdict: 'exit code 2',
      durationMs: 248_000,
      toolPreparationDurationMs: 242_000,
      toolExecutionDurationMs: 5_700,
      phaseStartAt: 1_000,
    });
    expect(screen.getByRole('button')).toHaveTextContent('exit code 2');
    expect(screen.queryByText(/Preparation|Tool call|Total elapsed|took/)).toBeNull();
    expect(screen.queryByTestId('stream-elapsed')).toBeNull();
  });

  it('shows no verdict on a successful card', () => {
    renderProgressText({ verdict: 'exit code 2' });
    expect(screen.queryByText(/exit code 2/)).not.toBeInTheDocument();
  });
});
