import '@testing-library/jest-dom';
import { fireEvent, render, screen } from '@testing-library/react';
import { Tag } from './Tag';

describe('Tag', () => {
  it('uses semantic status tokens while preserving the success default', () => {
    render(<Tag label="Enabled" onRemove={jest.fn()} />);

    expect(screen.getByText('Enabled').parentElement).toHaveClass(
      'bg-status-success-subtle',
      'text-status-success',
    );
  });

  it('supports alternate tones and removal callbacks', () => {
    const onRemove = jest.fn();
    render(<Tag label="Warning" variant="warning" onRemove={onRemove} />);

    expect(screen.getByText('Warning').parentElement).toHaveClass(
      'bg-status-warning-subtle',
      'text-status-warning',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Remove Warning' }));
    expect(onRemove).toHaveBeenCalledTimes(1);
  });
});
