import '@testing-library/jest-dom/extend-expect';
import { render, screen } from '@testing-library/react';
import Collapse from '../Collapse';

describe('Collapse', () => {
  test('reveals its content when open', () => {
    const { container } = render(
      <Collapse open={true}>
        <span data-testid="child" />
      </Collapse>,
    );
    expect(screen.getByTestId('child')).toBeInTheDocument();
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('grid-rows-[1fr]');
    expect(root).not.toHaveAttribute('aria-hidden');
  });

  test('collapses and hides from assistive tech when closed', () => {
    const { container } = render(
      <Collapse open={false}>
        <span data-testid="child" />
      </Collapse>,
    );
    const root = container.firstChild as HTMLElement;
    expect(root).toHaveClass('grid-rows-[0fr]');
    expect(root).toHaveAttribute('aria-hidden', 'true');
  });

  test('clips content while open by default', () => {
    const { container } = render(
      <Collapse open={true}>
        <span data-testid="child" />
      </Collapse>,
    );
    const clipWrapper = (container.firstChild as HTMLElement).firstElementChild as HTMLElement;
    expect(clipWrapper).toHaveClass('overflow-hidden');
  });

  test('lifts the clip while open for popover-hosting content, restoring it when closed', () => {
    const { container, rerender } = render(
      <Collapse open={true} overflowVisibleWhenOpen>
        <span data-testid="child" />
      </Collapse>,
    );
    const clipWrapper = (container.firstChild as HTMLElement).firstElementChild as HTMLElement;
    expect(clipWrapper).toHaveClass('overflow-visible');
    expect(clipWrapper).not.toHaveClass('overflow-hidden');

    rerender(
      <Collapse open={false} overflowVisibleWhenOpen>
        <span data-testid="child" />
      </Collapse>,
    );
    expect(clipWrapper).toHaveClass('overflow-hidden');
    expect(clipWrapper).not.toHaveClass('overflow-visible');
  });
});
