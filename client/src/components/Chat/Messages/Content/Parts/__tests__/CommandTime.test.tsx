import { act, render, screen } from '@testing-library/react';
import type { ToolCallPhase } from '@librechat/chat';
import CommandTime, { useCommandClock } from '../CommandTime';

function Clock({ phase, durationMs }: { phase: ToolCallPhase; durationMs?: number }) {
  return <CommandTime phase={phase} ms={useCommandClock(phase, durationMs)} />;
}

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values: Record<string, string>) =>
    key === 'com_ui_duration_seconds' ? `${values[0]}s` : key,
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));

afterEach(() => jest.useRealTimers());
it('ticks in tenths while running and stops once completed', () => {
  jest.useFakeTimers();
  const view = render(<Clock phase="running" />);
  act(() => jest.advanceTimersByTime(10200));
  expect(screen.getByTestId('command-time')).toHaveTextContent('10.2s');
  view.rerender(<Clock phase="completed" durationMs={10300} />);
  act(() => jest.advanceTimersByTime(5000));
  expect(screen.getByTestId('command-time')).toHaveTextContent('10.3s');
});
it('does not invent a duration for historical commands without metadata', () => {
  render(<Clock phase="completed" />);
  expect(screen.queryByTestId('command-time')).toBeNull();
});
it('shows failed command durations', () => {
  render(<Clock phase="failed" durationMs={10200} />);
  expect(screen.getByTestId('command-time')).toHaveTextContent('10.2s');
});
it('keeps the measured time when the display moves to a new place on completion', () => {
  jest.useFakeTimers();
  function Card({ phase }: { phase: ToolCallPhase }) {
    const ms = useCommandClock(phase);
    return phase === 'running' ? (
      <div>
        <CommandTime phase={phase} ms={ms} />
      </div>
    ) : (
      <section>
        <CommandTime phase={phase} ms={ms} />
      </section>
    );
  }
  const view = render(<Card phase="running" />);
  act(() => jest.advanceTimersByTime(4200));
  view.rerender(<Card phase="completed" />);
  expect(screen.getByTestId('command-time')).toHaveTextContent('4.2s');
});
