import '@testing-library/jest-dom/extend-expect';
import React from 'react';
import { Circle } from 'lucide-react';
import { render, screen } from '@testing-library/react';
import OptionToggle from '../OptionToggle';

jest.mock('@librechat/client', () => ({
  TooltipAnchor: ({ render }: { render: React.ReactElement }) => render,
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ComponentProps<'button'> & { variant?: string; size?: string }) => (
    <button {...props}>{children}</button>
  ),
}));

describe('OptionToggle', () => {
  it('gives the pressed state a semantic surface, foreground, and series border', () => {
    render(
      <OptionToggle
        icon={Circle}
        pressed={true}
        label="Background"
        activeBorderClass="border-series-1"
        onToggle={jest.fn()}
      />,
    );

    const button = screen.getByRole('button', { name: 'Background' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveClass(
      'border',
      'border-series-1',
      'bg-surface-active',
      'text-text-primary',
      'hover:bg-surface-active-alt',
    );
    expect(button.querySelector('svg')).toHaveClass('size-4');
    expect(button.querySelector('svg')).not.toHaveClass('text-series-1');
  });

  it('keeps the unpressed state neutral and transparent', () => {
    render(
      <OptionToggle
        icon={Circle}
        pressed={false}
        label="Background"
        activeBorderClass="border-series-1"
        onToggle={jest.fn()}
      />,
    );

    const button = screen.getByRole('button', { name: 'Background' });
    expect(button).toHaveAttribute('aria-pressed', 'false');
    expect(button).toHaveClass('border-transparent', 'text-text-secondary');
    expect(button).not.toHaveClass('border-series-1', 'bg-surface-active');
  });

  /** A tool switched to programmatic-only keeps its stored Intent state and
   *  keeps reporting it through `aria-pressed`, so the disabled treatment has to
   *  layer over the pressed one instead of replacing it. */
  it('keeps the pressed treatment while disabled', () => {
    render(
      <OptionToggle
        icon={Circle}
        pressed={true}
        disabled={true}
        label="Intent"
        activeBorderClass="border-series-1"
        onToggle={jest.fn()}
      />,
    );

    const button = screen.getByRole('button', { name: 'Intent' });
    expect(button).toHaveAttribute('aria-pressed', 'true');
    expect(button).toHaveClass('border-series-1', 'bg-surface-active', 'cursor-not-allowed');
    expect(button).not.toHaveClass('border-transparent');
  });
});
