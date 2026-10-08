import React from 'react';
import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { SendActions } from './SendActions';

/**
 * Renders the hovercard eagerly. Ariakit's real show path depends on pointer
 * timers and layout, and these assertions are about which rows this module
 * renders, not about Ariakit's hover behavior. The same substitution is made in
 * `DuringRunSendButton.test.tsx`, whose 13 tests cover the populated rows
 * through this module's other host.
 */
jest.mock('@ariakit/react', () => ({
  HovercardProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  HovercardAnchor: ({ render }: { render: React.ReactElement }) => render,
  Hovercard: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const anchor = (
  <button type="button" aria-label="Send">
    send
  </button>
);

describe('SendActions', () => {
  /** A host may pass a list that is sometimes empty — a settled run offers no
   *  alternate submission — and must not have to branch for it. */
  it('renders the anchor alone when there is nothing else to offer', () => {
    const { container } = render(<SendActions anchor={anchor} actions={[]} label="More" />);

    expect(screen.getByLabelText('Send')).toBeInTheDocument();
    expect(container.querySelectorAll('button')).toHaveLength(1);
  });

  it('offers each action beside the anchor', () => {
    const steer = jest.fn();
    const queue = jest.fn();
    render(
      <SendActions
        anchor={anchor}
        label="More"
        actions={[
          { key: 'steer', label: 'Steer', kbd: '⏎', onClick: steer },
          { key: 'queue', label: 'Queue', onClick: queue },
        ]}
      />,
    );

    expect(screen.getByLabelText('Send')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Queue').closest('button') as HTMLButtonElement);
    expect(queue).toHaveBeenCalledTimes(1);
    expect(steer).not.toHaveBeenCalled();
  });

  /** A disabled row's action refuses its chord too, so the hint would advertise
   *  a key that does nothing. */
  it('withholds a disabled row and its chord', () => {
    const onClick = jest.fn();
    render(
      <SendActions
        anchor={anchor}
        label="More"
        actions={[{ key: 'queue', label: 'Queue', kbd: '⌘⏎', disabled: true, onClick }]}
      />,
    );

    const row = screen.getByText('Queue').closest('button') as HTMLButtonElement;
    expect(row).toHaveAttribute('aria-disabled', 'true');
    expect(row.querySelector('kbd')).toBeNull();
    fireEvent.click(row);
    expect(onClick).not.toHaveBeenCalled();
  });
});
