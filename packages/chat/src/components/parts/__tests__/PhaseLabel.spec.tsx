/** @jest-environment jsdom */
import { fireEvent, render, screen } from '@testing-library/react';
import PhaseLabel, { FOLD_EASING } from '../PhaseLabel';

const first = 'Compared both release paths';
const next = 'Confirmed the rollback path is clean';

describe('PhaseLabel', () => {
  test('renders the initial line without replaying a slide', () => {
    render(<PhaseLabel text={first} animate lineId="phase-line" />);

    expect(screen.getByText(first)).toHaveAttribute('id', 'phase-line');
    expect(screen.getByText(first)).not.toHaveClass('animate-in');
    expect(screen.getByTitle(first)).toHaveClass('tool-status-text', 'flex-1');
  });

  test('retires the old summary with the same easing as the incoming line', () => {
    const { rerender } = render(<PhaseLabel text={first} animate />);
    rerender(<PhaseLabel text={next} animate />);

    const retired = screen.getByText(first);
    const current = screen.getByText(next);
    expect(retired).toHaveAttribute('aria-hidden', 'true');
    expect(retired).toHaveClass('absolute', 'animate-out', 'slide-out-to-top-5');
    expect(current).toHaveClass('animate-in', 'slide-in-from-bottom-5');
    for (const easingClass of FOLD_EASING.split(' ')) {
      expect(retired).toHaveClass(easingClass);
      expect(current).toHaveClass(easingClass);
    }

    fireEvent.animationEnd(retired);

    expect(screen.queryByText(first)).not.toBeInTheDocument();
    expect(screen.getByText(next)).toBe(current);
    expect(current).toHaveClass('animate-in');
  });

  test('replaces the summary immediately when animation is disabled', () => {
    const { rerender } = render(<PhaseLabel text={first} animate={false} />);
    rerender(<PhaseLabel text={next} animate={false} />);

    expect(screen.queryByText(first)).not.toBeInTheDocument();
    expect(screen.getByText(next)).not.toHaveClass('animate-in');
    expect(screen.getByTitle(next)).toBeInTheDocument();
  });

  test('does not animate the first nonempty summary', () => {
    const { rerender } = render(<PhaseLabel text="" animate />);
    rerender(<PhaseLabel text={first} animate />);

    expect(screen.getByText(first)).not.toHaveClass('animate-in');
  });

  test('extends a streamed sentence in place while its source stays the same', () => {
    const { rerender } = render(<PhaseLabel text="Checking" source="think:1" animate live />);
    const line = screen.getByText('Checking').parentElement;
    rerender(<PhaseLabel text="Checking both release paths" source="think:1" animate live />);

    expect(screen.queryByText('Checking')).not.toBeInTheDocument();
    expect(screen.getByText('Checking both release paths').parentElement).toBe(line);
    expect(line).not.toHaveClass('animate-in');
    expect(screen.getByText('Checking both release paths')).toHaveClass('shimmer', 'align-top');
  });

  test('keeps a slide on the same element as the incoming streamed sentence grows', () => {
    const { rerender } = render(<PhaseLabel text={first} source="tool:1" animate live />);
    rerender(<PhaseLabel text="Checking" source="think:1" animate live />);
    const current = screen.getByText('Checking').parentElement;
    expect(current).toHaveClass('animate-in');

    rerender(<PhaseLabel text="Checking both paths" source="think:1" animate live />);

    expect(screen.getByText('Checking both paths').parentElement).toBe(current);
    expect(current).toHaveClass('animate-in');
  });

  test('ignores a bubbled shimmer animation ending before the retired slide ends', () => {
    const { rerender } = render(<PhaseLabel text={first} source="tool:1" animate live />);
    rerender(<PhaseLabel text={next} source="tool:2" animate live />);
    const retiredText = screen.getByText(first);
    const retired = retiredText.parentElement;
    expect(retired).toHaveAttribute('aria-hidden', 'true');
    expect(retiredText).toHaveClass('shimmer');
    expect(retiredText).not.toHaveClass('absolute');

    fireEvent.animationEnd(retiredText);
    expect(screen.getByText(first)).toBeInTheDocument();

    if (retired == null) {
      throw new Error('The retired line must wrap its shimmering text.');
    }
    fireEvent.animationEnd(retired);
    expect(screen.queryByText(first)).not.toBeInTheDocument();
    expect(screen.getByText(next).parentElement).toHaveClass('animate-in');
  });

  test('keeps only the latest retired line across successive summary changes', () => {
    const { rerender } = render(<PhaseLabel text={first} animate />);
    rerender(<PhaseLabel text={next} animate />);
    rerender(<PhaseLabel text="Finished" animate />);

    expect(screen.queryByText(first)).not.toBeInTheDocument();
    expect(screen.getByText(next)).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Finished')).not.toHaveAttribute('aria-hidden');
  });

  test('can size to the label so the multiplier sits immediately after it', () => {
    render(<PhaseLabel text={first} animate grow={false} />);

    expect(screen.getByTitle(first)).not.toHaveClass('flex-1');
  });
});
