import React from 'react';
import { render, renderHook, screen, fireEvent } from '@testing-library/react';
import { FoldRail, RailGlyph, revealFoldHeader, useRailHover } from '../rail';

function box(top: number) {
  const el = document.createElement('div');
  el.getBoundingClientRect = () => ({ top }) as DOMRect;
  el.scrollIntoView = jest.fn();
  return el;
}

describe('revealFoldHeader', () => {
  it('scrolls the card to its start when the header is pinned below the card top', () => {
    const root = box(-400);
    const header = box(0);
    revealFoldHeader(root, header);
    expect(root.scrollIntoView).toHaveBeenCalledWith({ block: 'start' });
    expect(header.scrollIntoView).not.toHaveBeenCalled();
  });

  it('brings an unpinned header just into view', () => {
    const root = box(-400);
    const header = box(-400);
    revealFoldHeader(root, header);
    expect(header.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' });
    expect(root.scrollIntoView).not.toHaveBeenCalled();
  });
});

describe('FoldRail', () => {
  it('drops the knob when it unmounts under the pointer', () => {
    const { result } = renderHook(() => useRailHover());
    const hover = result.current;
    const { unmount } = render(<FoldRail hover={hover} onCollapse={jest.fn()} />);
    render(
      <RailGlyph hover={hover}>
        <span data-testid="glyph" />
      </RailGlyph>,
    );
    fireEvent.mouseEnter(screen.getByTestId('fold-rail'));
    expect(screen.getByTestId('fold-rail-knob')).toBeInTheDocument();
    unmount();
    expect(screen.queryByTestId('fold-rail-knob')).toBeNull();
    expect(screen.getByTestId('glyph')).toBeInTheDocument();
  });
});
