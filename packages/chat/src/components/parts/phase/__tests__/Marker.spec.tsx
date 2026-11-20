/** @jest-environment jsdom */
import { render, screen } from '@testing-library/react';
import PhaseMarker, { PhaseGlyph } from '../Marker';
import { FOLD_EASING } from '../../PhaseLabel';
import { ROW_GLYPH_SLOT } from '../../rows';

const label = 'Compared both release paths';

describe('PhaseMarker', () => {
  test('renders a noninteractive status with the phase label and shared row geometry', () => {
    render(<PhaseMarker label={label} failed={false} />);

    expect(screen.getByRole('status')).toHaveTextContent(label);
    expect(screen.getByRole('status')).toHaveAttribute('title', label);
    expect(screen.getByRole('status')).toHaveClass('tool-status-text', 'truncate', 'text-start');
    expect(screen.queryByRole('button')).toBeNull();
    const card = screen.getByTestId('activity-phase-card');
    expect(card).toHaveClass('min-h-7', 'gap-2', 'py-1');
    expect(card.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    for (const token of ROW_GLYPH_SLOT.split(' ')) {
      expect(card.firstElementChild).toHaveClass(token);
    }
  });

  test('applies entrance and reduced-motion classes only when the host requests animation', () => {
    const { rerender } = render(<PhaseMarker label={label} failed={false} animate />);
    const card = screen.getByTestId('activity-phase-card');
    expect(card).toHaveClass('animate-in', 'fade-in-0', 'motion-reduce:animate-none');
    for (const token of FOLD_EASING.split(' ')) {
      expect(card).toHaveClass(token);
    }

    rerender(<PhaseMarker label={label} failed={false} />);
    expect(card).not.toHaveClass('animate-in');
    for (const token of FOLD_EASING.split(' ')) {
      expect(card).not.toHaveClass(token);
    }
  });

  test.each([
    [false, false, 'lucide-check', 'text-text-secondary'],
    [false, true, 'lucide-triangle-alert', 'text-status-warning'],
    [true, false, 'lucide-circle-x', 'text-status-error'],
    [true, true, 'lucide-circle-x', 'text-status-error'],
  ])('preserves status precedence for failed=%s partial=%s', (failed, partial, glyph, tone) => {
    const { container } = render(<PhaseGlyph failed={failed} partial={partial} />);

    expect(container.firstElementChild).toHaveClass(tone);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelectorAll('svg')).toHaveLength(1);
    expect(container.querySelector('svg')).toHaveClass(glyph);
    expect(container.querySelector('svg')).toHaveAttribute('width', '14');
  });
});
