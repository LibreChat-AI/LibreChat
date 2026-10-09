import '@testing-library/jest-dom';
import { render, screen } from '@testing-library/react';
import { SeriesLabel } from './SeriesLabel';

describe('SeriesLabel', () => {
  it('keeps the label on the neutral text role and the hue on a hidden dot', () => {
    render(<SeriesLabel hue={7}>POST</SeriesLabel>);

    const label = screen.getByText('POST');
    const dot = label.querySelector('[aria-hidden="true"]');

    expect(label).toHaveClass('text-text-secondary');
    expect(label.className).not.toMatch(/text-series-/);
    expect(dot).toHaveClass('bg-series-7');
  });

  it('maps the error hue to the status error role', () => {
    render(<SeriesLabel hue="error">DELETE</SeriesLabel>);

    expect(screen.getByText('DELETE').querySelector('[aria-hidden="true"]')).toHaveClass(
      'bg-status-error',
    );
  });

  it('renders the label alone when no hue applies', () => {
    render(<SeriesLabel>OPTIONS</SeriesLabel>);

    expect(screen.getByText('OPTIONS').querySelector('[aria-hidden="true"]')).toBeNull();
  });
});
