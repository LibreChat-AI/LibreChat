import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { Chip } from './Chip';

describe('Chip', () => {
  it('renders a theme-aware surface tone for non-status context', () => {
    render(<Chip tone="surface">Context</Chip>);

    expect(screen.getByText('Context').parentElement).toHaveClass(
      'border-border-light',
      'bg-surface-secondary',
      'text-text-secondary',
    );
  });

  it('renders semantic tone classes', () => {
    render(<Chip tone="info">Search result</Chip>);

    expect(screen.getByText('Search result').parentElement).toHaveClass(
      'bg-status-info-subtle',
      'text-status-info',
    );
  });

  it('stops propagation and calls the remove handler', () => {
    const onRemove = jest.fn();
    const onParentClick = jest.fn();

    render(
      <div onClick={onParentClick}>
        <Chip onRemove={onRemove} removeLabel="Remove filter">
          Filter
        </Chip>
      </div>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Remove filter' }));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onParentClick).not.toHaveBeenCalled();
  });

  it('exposes theme-owned shape and density recipes', () => {
    render(
      <Chip size="theme" shape="theme" onRemove={jest.fn()} removeLabel="Remove theme">
        Themeable
      </Chip>,
    );

    expect(screen.getByText('Themeable').parentElement).toHaveClass(
      'h-theme-control',
      'rounded-theme-control',
      'gap-theme-compact',
    );
    expect(screen.getByRole('button', { name: 'Remove theme' })).toHaveClass(
      'rounded-theme-control-round',
    );
  });
});
