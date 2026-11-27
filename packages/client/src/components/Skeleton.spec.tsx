import { render, screen } from '@testing-library/react';
import { Skeleton } from './Skeleton';

it('owns reduced-motion handling while callers retain the placeholder silhouette', () => {
  render(<Skeleton data-testid="placeholder" className="size-12 rounded-full" />);

  expect(screen.getByTestId('placeholder')).toHaveClass(
    'animate-pulse',
    'motion-reduce:animate-none',
    'size-12',
    'rounded-full',
  );
});
