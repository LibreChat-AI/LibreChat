import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { FieldMessage } from './FieldMessage';

describe('FieldMessage', () => {
  it('always reserves a single helper line', () => {
    const { container } = render(<FieldMessage id="field-message" />);

    const line = container.querySelector('#field-message');
    expect(line).toBeInTheDocument();
    expect(line).toBeEmptyDOMElement();
    expect(line).toHaveClass('min-h-4', 'text-xs', 'leading-4', 'text-text-secondary');
    expect(line).not.toHaveAttribute('role');
  });

  it('renders resting hint text without alert semantics', () => {
    render(<FieldMessage id="field-message" hint="Helpful hint" />);

    const line = screen.getByText('Helpful hint');
    expect(line).toHaveClass('text-text-secondary');
    expect(line).not.toHaveAttribute('role');
  });

  it('gives an error precedence and alert semantics', () => {
    render(<FieldMessage id="field-message" message="Validation failed" hint="Helpful hint" />);

    const line = screen.getByRole('alert');
    expect(line).toHaveTextContent('Validation failed');
    expect(line).not.toHaveTextContent('Helpful hint');
    expect(line).toHaveClass('text-text-destructive');
  });

  it('reserves the requested number of helper lines', () => {
    const { container, rerender } = render(
      <FieldMessage id="field-message" hint="Helpful hint" lines={2} />,
    );

    expect(container.querySelector('#field-message')).toHaveClass('min-h-8');

    rerender(<FieldMessage id="field-message" message="Validation failed" lines={2} />);

    expect(container.querySelector('#field-message')).toHaveClass('min-h-8');
  });
});
