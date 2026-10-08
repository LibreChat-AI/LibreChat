import userEvent from '@testing-library/user-event';
import { createEvent, fireEvent, render, screen } from '@testing-library/react';
import Radio from './Radio';

jest.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const FIVE = [
  { value: 'hourly', label: 'Hourly' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' },
  { value: 'weekly', label: 'Weekly' },
  { value: 'cron', label: 'Custom' },
];

const group = (): HTMLElement => screen.getByRole('radiogroup');

describe('Radio', () => {
  it('exposes every option as a radio and marks the selected one', () => {
    render(<Radio options={FIVE} value="weekly" aria-labelledby="lbl" />);

    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByRole('radio', { name: 'Weekly' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Daily' })).toHaveAttribute('aria-checked', 'false');
  });

  it('keeps the segments on one row by default', () => {
    // The default must stay exactly as it was: every existing group relies on the
    // single-row layout and its indicator stretched between the container's insets.
    render(<Radio options={FIVE} value="daily" fullWidth />);

    expect(group().className).not.toContain('flex-wrap');
  });

  it('lets the segments flow onto a second row when asked', () => {
    // Each segment has a hard minimum width (px-4 plus a whitespace-nowrap label),
    // so without this five of them overflow a phone-width dialog and the choices
    // past the edge cannot be reached.
    render(<Radio options={FIVE} value="daily" fullWidth wrap />);

    expect(group().className).toContain('flex-wrap');
  });
});

describe('Radio keyboard navigation', () => {
  it('uses a roving tabIndex and focuses the first option when no value matches', () => {
    const { rerender } = render(<Radio options={FIVE} value="weekly" />);
    const radios = screen.getAllByRole('radio');

    expect(radios[0]).toHaveAttribute('tabIndex', '-1');
    expect(radios[3]).toHaveAttribute('tabIndex', '0');
    expect(radios[4]).toHaveAttribute('tabIndex', '-1');

    rerender(<Radio options={FIVE} value="missing" />);
    expect(screen.getAllByRole('radio')[0]).toHaveAttribute('tabIndex', '0');
    expect(screen.getAllByRole('radio')[1]).toHaveAttribute('tabIndex', '-1');
  });

  it('moves forward with ArrowRight and ArrowDown, moving focus to the new selection', () => {
    const onChange = jest.fn();
    render(<Radio options={FIVE} value="daily" onChange={onChange} />);

    const daily = screen.getByRole('radio', { name: 'Daily' });
    const weekdays = screen.getByRole('radio', { name: 'Weekdays' });
    daily.focus();

    const arrowRight = createEvent.keyDown(daily, { key: 'ArrowRight' });
    fireEvent(daily, arrowRight);

    expect(arrowRight.defaultPrevented).toBe(true);
    expect(onChange).toHaveBeenCalledWith('weekdays');
    expect(weekdays).toHaveAttribute('aria-checked', 'true');
    expect(document.activeElement).toBe(weekdays);

    daily.focus();
    fireEvent.keyDown(daily, { key: 'ArrowDown' });
    expect(onChange).toHaveBeenLastCalledWith('weekdays');
    expect(document.activeElement).toBe(weekdays);
  });

  it('moves backward with ArrowLeft and ArrowUp, wrapping in both directions', () => {
    const onChange = jest.fn();
    render(<Radio options={FIVE} value="daily" onChange={onChange} />);

    const first = screen.getByRole('radio', { name: 'Hourly' });
    const daily = screen.getByRole('radio', { name: 'Daily' });
    const last = screen.getByRole('radio', { name: 'Custom' });

    daily.focus();
    fireEvent.keyDown(daily, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('hourly');
    expect(document.activeElement).toBe(first);

    daily.focus();
    fireEvent.keyDown(daily, { key: 'ArrowUp' });
    expect(onChange).toHaveBeenLastCalledWith('hourly');
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowLeft' });
    expect(onChange).toHaveBeenLastCalledWith('cron');
    expect(document.activeElement).toBe(last);

    last.focus();
    fireEvent.keyDown(last, { key: 'ArrowRight' });
    expect(onChange).toHaveBeenLastCalledWith('hourly');
    expect(document.activeElement).toBe(first);
  });

  it('moves to the first and last options with Home and End', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Radio options={FIVE} value="weekdays" onChange={onChange} />);

    const first = screen.getByRole('radio', { name: 'Hourly' });
    const middle = screen.getByRole('radio', { name: 'Weekdays' });
    const last = screen.getByRole('radio', { name: 'Custom' });

    middle.focus();
    await user.keyboard('{Home}');
    expect(onChange).toHaveBeenLastCalledWith('hourly');
    expect(document.activeElement).toBe(first);

    first.focus();
    await user.keyboard('{End}');
    expect(onChange).toHaveBeenLastCalledWith('cron');
    expect(document.activeElement).toBe(last);
  });

  it('does not fire onChange when Home lands on the already-checked first option', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Radio options={FIVE} value="hourly" onChange={onChange} />);

    const first = screen.getByRole('radio', { name: 'Hourly' });
    first.focus();
    await user.keyboard('{Home}');

    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(first);
  });

  it('does not fire onChange when End lands on the already-checked last option', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Radio options={FIVE} value="cron" onChange={onChange} />);

    const last = screen.getByRole('radio', { name: 'Custom' });
    last.focus();
    await user.keyboard('{End}');

    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(last);
  });

  it('ignores keys other than the six navigation keys', async () => {
    const user = userEvent.setup();
    const onChange = jest.fn();
    render(<Radio options={FIVE} value="daily" onChange={onChange} />);

    const daily = screen.getByRole('radio', { name: 'Daily' });
    daily.focus();
    await user.keyboard('{Escape}');

    expect(onChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(daily);
  });

  it('does nothing when disabled or when there is only one option', () => {
    const disabledOnChange = jest.fn();
    const { unmount } = render(
      <Radio options={FIVE} value="daily" onChange={disabledOnChange} disabled />,
    );
    const disabledDaily = screen.getByRole('radio', { name: 'Daily' });

    fireEvent.keyDown(disabledDaily, { key: 'ArrowRight' });
    expect(disabledOnChange).not.toHaveBeenCalled();
    unmount();

    const singleOnChange = jest.fn();
    render(
      <Radio options={[{ value: 'only', label: 'Only' }]} value="only" onChange={singleOnChange} />,
    );
    const only = screen.getByRole('radio', { name: 'Only' });
    only.focus();

    fireEvent.keyDown(only, { key: 'ArrowRight' });
    expect(singleOnChange).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(only);
  });
});
