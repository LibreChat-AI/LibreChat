import { Brain } from 'lucide-react';
import { render, screen } from '@testing-library/react';
import EmptyState from './EmptyState';

describe('EmptyState', () => {
  it('renders a title, a description and a decorative icon', () => {
    const { container } = render(
      <EmptyState icon={Brain} title="No memories yet" description="Add one to get started" />,
    );

    expect(screen.getByText('No memories yet')).toBeInTheDocument();
    expect(screen.getByText('Add one to get started')).toBeInTheDocument();
    // The icon carries the meaning already in the text, so it must not be announced.
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it("gives a description the title's size when it stands alone", () => {
    // The "nothing matched your filter" shape has no title, so its one line must not
    // render as a caption underneath nothing.
    render(<EmptyState icon={Brain} description="No results match your filter" />);

    expect(screen.getByText('No results match your filter')).toHaveClass('text-sm');
    expect(screen.getByText('No results match your filter')).not.toHaveClass('text-xs');
  });

  it('renders an action when one is given, and nothing when it is not', () => {
    const { rerender } = render(<EmptyState icon={Brain} title="Could not load" />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(
      <EmptyState
        icon={Brain}
        title="Could not load"
        action={<button type="button">Retry</button>}
      />,
    );
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
