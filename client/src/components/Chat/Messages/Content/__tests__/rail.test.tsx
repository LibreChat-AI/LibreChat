import React from 'react';
import { render, renderHook, screen, fireEvent } from '@testing-library/react';
import { FoldRail, RailGlyph, revealFoldHeader, useRailHover } from '../rail';

function box(top: number, height = 28) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ top, height }) as DOMRect;
  el.scrollIntoView = jest.fn();
  return el;
}

describe('revealFoldHeader', () => {
  it('scrolls the card to its start when the header is pinned below the card top', () => {
    const root = box(-400);
    const header = box(0);
    revealFoldHeader(root, header);
    expect(root.scrollIntoView).toHaveBeenCalledWith({ block: 'start', behavior: 'instant' });
    expect(header.scrollIntoView).not.toHaveBeenCalled();
  });

  it('brings an unpinned header just into view', () => {
    const root = box(-400);
    const header = box(-400);
    revealFoldHeader(root, header);
    expect(header.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' });
    expect(root.scrollIntoView).not.toHaveBeenCalled();
  });

  it('reserves the sticky phase header height and restores the previous margin', () => {
    const root = box(-400);
    const header = box(-400);
    const phaseHeader = box(0, 36);
    header.style.scrollMarginTop = '8px';
    header.scrollIntoView = jest.fn(() => {
      expect(header.style.scrollMarginTop).toBe('36px');
    });
    revealFoldHeader(root, header, phaseHeader);
    expect(header.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'instant' });
    expect(header.style.scrollMarginTop).toBe('8px');
  });

  it.each([false, true])('reserves the host toolbar for a pinned=%s header', (pinned) => {
    const message = box(0);
    message.className = 'message-render';
    message.style.scrollMarginTop = '64px';
    const root = box(-400);
    const header = box(pinned ? 0 : -400);
    message.append(root);
    root.append(header);
    const target = pinned ? root : header;
    const phaseHeader = pinned ? null : box(0, 36);
    target.scrollIntoView = jest.fn(() => {
      expect(target.style.scrollMarginTop).toBe(pinned ? '64px' : '100px');
    });
    revealFoldHeader(root, header, phaseHeader);
    expect(target.scrollIntoView).toHaveBeenCalledWith({
      block: pinned ? 'start' : 'nearest',
      behavior: 'instant',
    });
    expect(target.style.scrollMarginTop).toBe('');
  });

  it('does nothing after the fold has unmounted', () => {
    expect(() => revealFoldHeader(null, null)).not.toThrow();
  });
});

describe('FoldRail', () => {
  it('drops the knob when it unmounts under the pointer', () => {
    const { result } = renderHook(() => useRailHover());
    const hover = result.current;
    const { unmount } = render(<FoldRail hover={hover} expanded onCollapse={jest.fn()} />);
    render(
      <RailGlyph hover={hover}>
        <span data-testid="glyph" />
      </RailGlyph>,
    );
    fireEvent.mouseEnter(screen.getByTestId('fold-rail'));
    expect(screen.getByTestId('fold-rail-knob')).toBeInTheDocument();
    expect(screen.getByTestId('glyph').parentElement).toHaveClass('invisible');
    unmount();
    expect(screen.queryByTestId('fold-rail-knob')).toBeNull();
    expect(screen.getByTestId('glyph').parentElement).not.toHaveClass('invisible');
  });

  it('keeps the same glyph mounted in layout across hover transitions', () => {
    const { result } = renderHook(() => useRailHover());
    const hover = result.current;
    const mounted = jest.fn();
    const unmounted = jest.fn();
    function Glyph() {
      React.useEffect(() => {
        mounted();
        return unmounted;
      }, []);
      return <span data-testid="glyph" />;
    }
    render(
      <>
        <FoldRail hover={hover} expanded onCollapse={jest.fn()} />
        <RailGlyph hover={hover}>
          <Glyph />
        </RailGlyph>
      </>,
    );
    const glyph = screen.getByTestId('glyph');
    fireEvent.mouseEnter(screen.getByTestId('fold-rail'));
    expect(screen.getByTestId('glyph')).toBe(glyph);
    fireEvent.mouseLeave(screen.getByTestId('fold-rail'));
    expect(screen.getByTestId('glyph')).toBe(glyph);
    expect(mounted).toHaveBeenCalledTimes(1);
    expect(unmounted).not.toHaveBeenCalled();
  });

  it('clears hover and disables the rail when a retained body collapses', () => {
    const { result } = renderHook(() => useRailHover());
    const hover = result.current;
    const collapse = jest.fn();
    const { rerender } = render(<FoldRail hover={hover} expanded onCollapse={collapse} />);
    fireEvent.mouseEnter(screen.getByTestId('fold-rail'));
    expect(hover.get()).toBe(true);
    rerender(<FoldRail hover={hover} expanded={false} onCollapse={collapse} />);
    expect(hover.get()).toBe(false);
    fireEvent.mouseEnter(screen.getByTestId('fold-rail'));
    fireEvent.click(screen.getByTestId('fold-rail'));
    expect(hover.get()).toBe(false);
    expect(collapse).not.toHaveBeenCalled();
    expect(screen.getByTestId('fold-rail')).toBeDisabled();
  });
});
