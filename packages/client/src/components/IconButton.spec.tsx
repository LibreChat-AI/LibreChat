import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { IconButton } from './IconButton';

describe('IconButton', () => {
  it('provides an accessible name and a safe default button type', () => {
    render(<IconButton label="Open menu">menu</IconButton>);

    expect(screen.getByRole('button', { name: 'Open menu' })).toHaveAttribute('type', 'button');
  });

  it('allows semantic variants and consumer class names', () => {
    render(
      <IconButton label="Delete" variant="destructive" size="sm" className="custom-class">
        delete
      </IconButton>,
    );

    const button = screen.getByRole('button', { name: 'Delete' });
    expect(button).toHaveClass('bg-surface-destructive', 'size-8', 'custom-class');
  });

  it('exposes theme-owned shape and control sizing', () => {
    render(
      <IconButton label="Theme control" size="theme" shape="theme">
        menu
      </IconButton>,
    );

    expect(screen.getByRole('button', { name: 'Theme control' })).toHaveClass(
      'size-theme-control',
      'rounded-theme-control-round',
    );
  });

  it('provides a theme-aware primary action', () => {
    render(
      <IconButton label="Send" variant="primary">
        send
      </IconButton>,
    );

    expect(screen.getByRole('button', { name: 'Send' })).toHaveClass(
      'bg-surface-inverted',
      'text-text-inverted',
      'hover:bg-surface-inverted-hover',
    );
  });
});
