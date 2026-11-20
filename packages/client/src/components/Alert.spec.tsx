import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { Alert } from './Alert';

describe('Alert', () => {
  it('keeps the inline padding by default and gives a standalone notice more air when roomy', () => {
    const { rerender } = render(<Alert>Saved</Alert>);
    expect(screen.getByRole('alert')).toHaveClass('px-4', 'py-3');

    rerender(<Alert size="roomy">Saved</Alert>);
    const roomy = screen.getByRole('alert');
    expect(roomy).toHaveClass('px-6', 'py-4');
    expect(roomy).not.toHaveClass('px-4');
  });
});
