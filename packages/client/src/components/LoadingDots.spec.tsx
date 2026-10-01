import { render, screen } from '@testing-library/react';
import { LoadingDots } from './LoadingDots';

it('supplies each decorative dot delay as a CSS variable for the shared animation recipe', () => {
  render(<LoadingDots data-testid="dots" count={4} />);

  const dots = screen.getByTestId('dots');
  expect(dots).toHaveAttribute('aria-hidden', 'true');
  expect(dots.children).toHaveLength(4);
  Array.from(dots.children).forEach((dot, index) => {
    expect(dot).toHaveStyle({ '--loading-dot-delay': `${index * 160}ms` });
    expect(dot).toHaveClass('animate-loading-dot', 'motion-reduce:animate-none');
    expect(dot).not.toHaveStyle({ animationDelay: `${index * 160}ms` });
  });
});
