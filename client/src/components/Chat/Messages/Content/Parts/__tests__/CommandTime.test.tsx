import { act, render, screen } from '@testing-library/react';
import CommandTime from '../CommandTime';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string, values: Record<string, string>) =>
    key === 'com_ui_duration_seconds' ? `${values[0]}s` : key,
}));
jest.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' } }) }));

afterEach(() => jest.useRealTimers());
it('ticks in tenths while running and stops once completed', () => {
  jest.useFakeTimers();
  const view = render(<CommandTime phase="running" />);
  act(() => jest.advanceTimersByTime(10200));
  expect(screen.getByTestId('command-time')).toHaveTextContent('10.2s');
  view.rerender(<CommandTime phase="completed" durationMs={10300} />);
  act(() => jest.advanceTimersByTime(5000));
  expect(screen.getByTestId('command-time')).toHaveTextContent('10.3s');
});
it('does not invent a duration for historical commands without metadata', () => {
  render(<CommandTime phase="completed" />);
  expect(screen.queryByTestId('command-time')).toBeNull();
});
it('shows failed command durations', () => {
  render(<CommandTime phase="failed" durationMs={10200} />);
  expect(screen.getByTestId('command-time')).toHaveTextContent('10.2s');
});
