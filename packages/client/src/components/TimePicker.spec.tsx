import { useState } from 'react';
import userEvent from '@testing-library/user-event';
import { render, screen, within } from '@testing-library/react';
import TimePicker, { MinutePicker } from './TimePicker';

const LABELS = { hour: 'Hour', minute: 'Minute', meridiem: 'AM or PM', am: 'AM', pm: 'PM' };

function Harness({ locale = 'en-US', hour12 = true }: { locale?: string; hour12?: boolean }) {
  const [time, setTime] = useState({ hour: 9, minute: 0 });
  return (
    <>
      <TimePicker
        hour={time.hour}
        minute={time.minute}
        locale={locale}
        hour12={hour12}
        labels={LABELS}
        onChange={setTime}
        labelledBy="time-label"
      />
      <span id="time-label">{'Time'}</span>
      <output data-testid="value">{`${time.hour}:${time.minute}`}</output>
    </>
  );
}

describe('TimePicker', () => {
  it('shows the time in the locale convention and opens three columns', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Time 9:00 AM' });

    await user.click(trigger);
    expect(screen.getByRole('radiogroup', { name: 'Hour' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'Minute' })).toBeInTheDocument();
    expect(screen.getByRole('radiogroup', { name: 'AM or PM' })).toBeInTheDocument();
  });

  it('inks its value in the field role like every other field', () => {
    render(<Harness />);

    const trigger = screen.getByRole('button', { name: 'Time 9:00 AM' });
    expect(trigger).toHaveClass('text-field-text');
    expect(trigger).not.toHaveClass('text-text-primary');
  });

  it('announces the selected time, not just the field label', () => {
    // `aria-labelledby` REPLACES a button's child text, so pointing it at the field
    // label alone announced "Time" and left the selected value unreadable without
    // opening the columns.
    render(<Harness />);

    expect(screen.getByRole('button', { name: 'Time 9:00 AM' })).toBeInTheDocument();
  });

  it('keeps the hour when switching to PM', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /^Time/ }));
    const meridiem = screen.getByRole('radiogroup', { name: 'AM or PM' });
    await user.click(within(meridiem).getByRole('radio', { name: 'PM' }));

    expect(screen.getByTestId('value')).toHaveTextContent('21:0');
  });

  it('moves through the minute column with the arrow keys and wraps', async () => {
    const user = userEvent.setup();
    render(<Harness />);

    await user.click(screen.getByRole('button', { name: /^Time/ }));
    const minutes = screen.getByRole('radiogroup', { name: 'Minute' });
    within(minutes).getByRole('radio', { name: '00' }).focus();

    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('value')).toHaveTextContent('9:1');

    // wrapping backwards past 00 reaches the end of the column rather than sticking
    within(minutes).getByRole('radio', { name: '00' }).focus();
    await user.keyboard('{ArrowUp}');
    expect(screen.getByTestId('value')).toHaveTextContent('9:59');
  });
});

describe('TimePicker initial centering', () => {
  /** jsdom reports every layout metric as 0, so the scroll maths cannot run against
   *  it. Give the column and its rows real ones. */
  function stubLayout() {
    const asNumber = (el: Element, attr: string) => Number(el.getAttribute(attr) ?? 0);
    jest.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return this.getAttribute('role') === 'radiogroup' ? 200 : 20;
    });
    jest.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return asNumber(this, 'data-value') * 20;
    });
  }

  afterEach(() => jest.restoreAllMocks());

  it('scrolls the selected row into the middle of its column on open', async () => {
    // React attaches descendant refs BEFORE the parent's, so doing this from the
    // button's ref callback read a null column and silently skipped the scroll,
    // leaving a picker opened on 9:00 sitting at 00.
    stubLayout();
    const user = userEvent.setup();
    render(<Harness hour12={false} />);

    await user.click(screen.getByRole('button', { name: /^Time/ }));

    const hours = screen.getByRole('radiogroup', { name: 'Hour' });
    // row 9 at 20px each, centred in a 200px column: 180 - (200 - 20) / 2
    expect(hours.scrollTop).toBe(90);
  });
});

describe('TimePicker clock format', () => {
  it('renders 24-hour columns when the host app resolves a 24-hour clock', async () => {
    const user = userEvent.setup();
    render(<Harness locale="en-US" hour12={false} />);

    expect(screen.getByRole('button', { name: /^Time/ })).toHaveTextContent('9:00');
    await user.click(screen.getByRole('button', { name: /^Time/ }));
    expect(screen.queryByRole('radiogroup', { name: 'AM or PM' })).not.toBeInTheDocument();
  });

  it('renders a meridiem column for a 24-hour LOCALE when the app says 12-hour', async () => {
    // The prop is the whole answer, deliberately: the app has already resolved its
    // Clock format setting, and re-guessing from the locale here would let the picker
    // disagree with the summary printed beside it.
    const user = userEvent.setup();
    render(<Harness locale="en-GB" hour12 />);

    expect(screen.getByRole('button', { name: /^Time/ })).toHaveTextContent(/AM/i);
    await user.click(screen.getByRole('button', { name: /^Time/ }));
    expect(screen.getByRole('radiogroup', { name: 'AM or PM' })).toBeInTheDocument();
  });
});

describe('MinutePicker', () => {
  function MinuteHarness() {
    const [minute, setMinute] = useState(0);
    return (
      <>
        <MinutePicker
          minute={minute}
          onChange={setMinute}
          label={LABELS.minute}
          labelledBy="minute-label"
        />
        <span id="minute-label">{'Minutes past the hour'}</span>
        <output data-testid="minute">{String(minute)}</output>
      </>
    );
  }

  it('opens a single minutes column and selects from it', async () => {
    const user = userEvent.setup();
    render(<MinuteHarness />);

    const trigger = screen.getByRole('button', { name: 'Minutes past the hour 00' });
    expect(trigger).toHaveTextContent('00');

    await user.click(trigger);
    const minutes = screen.getByRole('radiogroup', { name: 'Minute' });
    expect(screen.queryByRole('radiogroup', { name: 'Hour' })).not.toBeInTheDocument();

    await user.click(within(minutes).getByRole('radio', { name: '30' }));
    expect(screen.getByTestId('minute')).toHaveTextContent('30');
  });
});
