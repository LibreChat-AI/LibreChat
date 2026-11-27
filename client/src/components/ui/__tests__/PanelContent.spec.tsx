import '@testing-library/jest-dom/extend-expect';
import { createRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import PanelContent from '../PanelContent';

describe('PanelContent', () => {
  const skeleton = <div data-testid="skeleton" aria-hidden="true" />;

  test('announces loading while the skeleton stands in for the rows', () => {
    render(
      <PanelContent isLoading={true} skeleton={skeleton}>
        <span data-testid="rows" />
      </PanelContent>,
    );

    expect(screen.getByTestId('skeleton')).toBeInTheDocument();
    expect(screen.queryByTestId('rows')).not.toBeInTheDocument();

    /** The skeleton is aria-hidden, so the announcement has to come from elsewhere */
    const announcement = screen.getByText('Loading...');
    expect(announcement).toHaveClass('sr-only');
    expect(announcement).toHaveAttribute('aria-live', 'polite');
  });

  test('marks the scroll container busy only while loading', () => {
    const { container, rerender } = render(<PanelContent isLoading={true} skeleton={skeleton} />);
    const scroller = () => container.querySelector('.overflow-y-auto');
    expect(scroller()).toHaveAttribute('aria-busy', 'true');

    rerender(<PanelContent isLoading={false} skeleton={skeleton} />);
    expect(scroller()).toHaveAttribute('aria-busy', 'false');
  });

  test('renders children once loaded', () => {
    render(
      <PanelContent isLoading={false} skeleton={skeleton}>
        <span data-testid="rows" />
      </PanelContent>,
    );

    expect(screen.getByTestId('rows')).toBeInTheDocument();
    expect(screen.queryByTestId('skeleton')).not.toBeInTheDocument();
    expect(screen.queryByText('Loading...')).not.toBeInTheDocument();
  });

  test('renders the empty state instead of children when the list is empty', () => {
    render(
      <PanelContent
        isLoading={false}
        isEmpty={true}
        skeleton={skeleton}
        empty={<span data-testid="empty" />}
      >
        <span data-testid="rows" />
      </PanelContent>,
    );

    expect(screen.getByTestId('empty')).toBeInTheDocument();
    expect(screen.queryByTestId('rows')).not.toBeInTheDocument();
  });

  test('falls back to children when empty but given no empty state', () => {
    render(
      <PanelContent isLoading={false} isEmpty={true} skeleton={skeleton}>
        <span data-testid="rows" />
      </PanelContent>,
    );

    expect(screen.getByTestId('rows')).toBeInTheDocument();
  });

  test('forwards its ref to the scroll container so panels can fetch on scroll', () => {
    const ref = createRef<HTMLDivElement>();
    const { container } = render(
      <PanelContent ref={ref} isLoading={false} skeleton={skeleton} className="px-4" />,
    );

    expect(ref.current).toBe(container.querySelector('.overflow-y-auto'));
    expect(ref.current).toHaveClass('overflow-y-auto', 'px-4');
  });

  test('hints at content below the fold only while there is some', () => {
    const { container } = render(
      <PanelContent isLoading={false} skeleton={skeleton}>
        <span data-testid="rows" />
      </PanelContent>,
    );

    /** jsdom reports every element as zero-height, so nothing overflows and the
     *  fade stays hidden. What this pins is that it renders, is decorative, and
     *  never intercepts a click aimed at the last row. */
    const fade = container.querySelector('.pointer-events-none.absolute');
    expect(fade).toBeInTheDocument();
    expect(fade).toHaveAttribute('aria-hidden', 'true');
    expect(fade).toHaveClass('opacity-0');
  });

  test('tracks overflowing content after loading and after more rows arrive', async () => {
    const originalObserver = global.ResizeObserver;
    const observed = new Set<Element>();
    let notifyResize = () => {};
    global.ResizeObserver = jest.fn().mockImplementation((callback) => {
      notifyResize = () => callback([], {});
      return {
        observe: (node: Element) => observed.add(node),
        unobserve: (node: Element) => observed.delete(node),
        disconnect: () => observed.clear(),
      };
    });

    try {
      const ref = createRef<HTMLDivElement>();
      const { container, rerender } = render(
        <PanelContent ref={ref} isLoading={true} skeleton={skeleton} />,
      );
      const scroller = ref.current!;
      Object.defineProperties(scroller, {
        clientHeight: { value: 100, configurable: true },
        scrollHeight: { value: 200, configurable: true },
      });
      const fade = container.querySelector('.pointer-events-none.absolute');
      const resizeContent = () => {
        // Only live content boxes resize here; the scroller stays 100px tall.
        if ([...observed].some((node) => node !== scroller && scroller.contains(node))) {
          act(notifyResize);
        }
      };

      await act(async () => {
        rerender(
          <PanelContent ref={ref} isLoading={false} skeleton={skeleton}>
            <div>
              <div data-testid="row-1" />
            </div>
          </PanelContent>,
        );
      });
      resizeContent();
      expect(fade).toHaveClass('opacity-100');

      scroller.scrollTop = 100;
      fireEvent.scroll(scroller);
      expect(fade).toHaveClass('opacity-0');

      Object.defineProperty(scroller, 'scrollHeight', { value: 300, configurable: true });
      await act(async () => {
        rerender(
          <PanelContent ref={ref} isLoading={false} skeleton={skeleton}>
            <div>
              <div data-testid="row-1" />
              <div data-testid="row-2" />
            </div>
          </PanelContent>,
        );
      });
      resizeContent();
      expect(fade).toHaveClass('opacity-100');
    } finally {
      global.ResizeObserver = originalObserver;
    }
  });
});
