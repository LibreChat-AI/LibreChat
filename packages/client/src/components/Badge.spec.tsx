import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import Badge from './Badge';

describe('Badge', () => {
  it('keeps the editing action button outside the badge button', () => {
    const onBadgeAction = jest.fn();
    const { container } = render(
      <Badge label="Tool" isAvailable={true} isEditing onBadgeAction={onBadgeAction} />,
    );

    expect(container.querySelector('button button')).toBeNull();
    expect(container.firstElementChild?.tagName).toBe('DIV');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Tool' }));
    expect(onBadgeAction).toHaveBeenCalledTimes(1);
  });

  it('forwards editing-mode attributes and event handlers to the wrapper', () => {
    const onMouseDown = jest.fn();
    render(
      <Badge
        label="Tool"
        isAvailable={true}
        isEditing
        aria-label="Editable tool"
        data-testid="editable-badge"
        onMouseDown={onMouseDown}
      />,
    );

    const badge = screen.getByTestId('editable-badge');
    expect(badge).toHaveAttribute('aria-label', 'Editable tool');

    fireEvent.mouseDown(badge);
    expect(onMouseDown).toHaveBeenCalledTimes(1);
  });

  /** The label reads its own ink role, which a theme can set apart from body copy. */
  it('labels a resting badge in the badge label ink and a hovered or selected one in the primary ink', () => {
    const { rerender } = render(<Badge label="Tools" isAvailable={true} />);
    expect(screen.getByRole('button', { name: 'Tools' })).toHaveClass(
      'text-badge-label',
      'hover:text-text-primary',
    );

    rerender(<Badge label="Tools" isAvailable={true} isActive />);
    const selected = screen.getByRole('button', { name: 'Tools' });
    expect(selected).toHaveClass('text-text-primary');
    expect(selected).not.toHaveClass('text-badge-label');
  });

  /** A disabled badge keeps its resting ink on hover, as it keeps its resting shadow. */
  it('keeps a disabled badge in its resting ink on hover', () => {
    render(<Badge id="1" label="Tools" isAvailable={true} isInChat />);
    const badge = screen.getByRole('button', { name: 'Tools' });

    expect(badge).toHaveClass('hover:text-badge-label');
    expect(badge).not.toHaveClass('hover:text-text-primary');
  });

  it('keeps a disabled selected badge in the primary ink on hover', () => {
    render(<Badge id="1" label="Tools" isAvailable={true} isInChat isActive />);
    const badge = screen.getByRole('button', { name: 'Tools' });

    expect(badge).toHaveClass('text-text-primary');
    expect(badge).not.toHaveClass('hover:text-badge-label');
  });
});
