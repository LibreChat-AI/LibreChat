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

  it('states a quiet error in the copy color on the error border and fill', () => {
    render(
      <Alert variant="error-quiet" icon={false}>
        Offline
      </Alert>,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass(
      'border-alert-error-border',
      'bg-alert-error-fill',
      'text-text-secondary',
    );
    expect(alert).not.toHaveClass('text-status-error');
  });
});
