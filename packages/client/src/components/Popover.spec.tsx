import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { Popover, PopoverClose, PopoverPortal, PopoverContent, PopoverTrigger } from './Popover';

function Example({ modal = false }: { modal?: boolean }) {
  return (
    <Popover modal={modal}>
      <PopoverTrigger asChild>
        <button type="button">Open</button>
      </PopoverTrigger>
      <PopoverPortal>
        <PopoverContent role="dialog" aria-label="Details" className="custom-panel">
          <p>Body</p>
          <PopoverClose asChild>
            <button type="button">Close</button>
          </PopoverClose>
        </PopoverContent>
      </PopoverPortal>
    </Popover>
  );
}

describe('Popover', () => {
  it('opens from its trigger and closes from its close part', () => {
    render(<Example />);
    const trigger = screen.getByRole('button', { name: 'Open' });
    expect(screen.queryByRole('dialog', { name: 'Details' })).not.toBeInTheDocument();

    fireEvent.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByRole('dialog', { name: 'Details' })).toHaveTextContent('Body');

    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Details' })).not.toBeInTheDocument();
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('portals the content out of the trigger tree on the shared panel surface', () => {
    const { container } = render(<Example modal />);
    fireEvent.click(screen.getByRole('button', { name: 'Open' }));

    const panel = screen.getByRole('dialog', { name: 'Details' });
    expect(container).not.toContainElement(panel);
    expect(panel).toHaveClass(
      'bg-surface-secondary',
      'border-border-light',
      'rounded-theme-popover',
      'motion-reduce:animate-none',
      'custom-panel',
    );
  });

  it('forwards its ref to the content element', () => {
    const ref = React.createRef<HTMLDivElement>();
    render(
      <Popover open>
        <PopoverTrigger>Open</PopoverTrigger>
        <PopoverContent ref={ref}>Body</PopoverContent>
      </Popover>,
    );

    expect(ref.current).toBe(screen.getByText('Body'));
  });
});
