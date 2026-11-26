/**
 * @jest-environment jsdom
 */
import '@testing-library/jest-dom/extend-expect';
import { act, fireEvent, render, screen } from '@testing-library/react';
import UsagePopover from '../Popover';

const renderPopover = (wide = false) =>
  render(
    <UsagePopover
      resetKey="convo-1"
      label="Context usage"
      cardLabel="Context usage"
      wide={wide}
      trigger={() => <span>gauge</span>}
    >
      <button type="button">Toggle details</button>
    </UsagePopover>,
  );

const advance = (ms: number) => act(() => jest.advanceTimersByTime(ms));

/** Past the hide delay, then past the leave transition: each step's state has
 *  to flush before the timers it schedules can run. */
const settle = () => {
  advance(200);
  advance(2000);
};

/** Hover opens the card after the intent delay. */
const openByHover = () => {
  fireEvent.pointerEnter(screen.getByTestId('token-usage'), { pointerType: 'mouse' });
  advance(200);
  return screen.getByRole('dialog');
};

describe('Context usage popover', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('closes a hover-opened card once the pointer leaves it', () => {
    renderPopover();
    const card = openByHover();

    fireEvent.pointerLeave(card, { pointerType: 'mouse' });
    settle();

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('keeps a hover-opened card open after a press inside it', () => {
    renderPopover();
    const card = openByHover();

    /** A control that resizes the card moves it out from under the pointer. */
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Toggle details' }));
    fireEvent.pointerLeave(card, { pointerType: 'mouse' });
    settle();

    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('eases the card between its narrow and wide widths', () => {
    const { rerender } = renderPopover();
    openByHover();
    const frame = () => screen.getByRole('button', { name: 'Toggle details' }).parentElement;
    expect(frame()).toHaveClass('w-72', 'max-w-full', 'transition-width');

    rerender(
      <UsagePopover
        resetKey="convo-1"
        label="Context usage"
        cardLabel="Context usage"
        wide
        trigger={() => <span>gauge</span>}
      >
        <button type="button">Toggle details</button>
      </UsagePopover>,
    );
    expect(frame()).toHaveClass('w-(--usage-card-wide)', 'max-w-full', 'transition-width');
    expect(frame()).not.toHaveClass('w-72');
  });
});
