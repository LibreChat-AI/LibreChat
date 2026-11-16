import { render, screen } from '@testing-library/react';
import { Shimmer } from './Shimmer';

describe('Shimmer', () => {
  it('keeps the label as the only text in the document and draws its copy from an attribute', () => {
    render(<Shimmer data-testid="label">Running tests</Shimmer>);

    const label = screen.getByTestId('label');
    expect(label).toHaveClass('shimmer');
    /** A text query finds one node, and the label reads as itself: the copy
     *  the sweep paints is generated content, never a second text node. */
    expect(screen.getAllByText('Running tests')).toEqual([label]);
    expect(label.textContent).toBe('Running tests');

    const clip = label.querySelector('.shimmer-clip');
    expect(clip).toHaveAttribute('aria-hidden', 'true');
    const copy = clip?.querySelector('.shimmer-band > .shimmer-copy');
    expect(copy).toHaveAttribute('data-text', 'Running tests');
    expect(copy).toBeEmptyDOMElement();
  });

  it('follows the label when it changes', () => {
    const { rerender } = render(<Shimmer data-testid="label">Reading files</Shimmer>);
    rerender(<Shimmer data-testid="label">Editing files</Shimmer>);

    const label = screen.getByTestId('label');
    expect(label.textContent).toBe('Editing files');
    expect(label.querySelector('.shimmer-copy')).toHaveAttribute('data-text', 'Editing files');
  });

  it('renders a label at rest with nothing added', () => {
    render(
      <Shimmer active={false} className="truncate" data-testid="label">
        Ran tests
      </Shimmer>,
    );

    const label = screen.getByTestId('label');
    expect(label).not.toHaveClass('shimmer');
    expect(label).toHaveClass('truncate');
    expect(label.childElementCount).toBe(0);
  });

  it('passes its own attributes to the label element', () => {
    render(
      <Shimmer aria-hidden="true" className="tabular-nums" title="elapsed">
        12s
      </Shimmer>,
    );

    const label = screen.getByTitle('elapsed');
    expect(label).toHaveClass('shimmer', 'tabular-nums');
    expect(label).toHaveAttribute('aria-hidden', 'true');
  });
});
