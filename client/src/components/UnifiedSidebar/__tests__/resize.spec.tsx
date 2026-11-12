import React from 'react';
import { render, fireEvent, screen } from '@testing-library/react';
import { createResizeMeasure } from '../resize';
import Sidebar from '../Sidebar';

jest.mock('~/components/SidePanel/Nav', () => ({
  __esModule: true,
  default: () => null,
}));

jest.mock('../ExpandedPanel', () => ({
  __esModule: true,
  default: () => null,
}));

const renderSidebar = (direction: 'ltr' | 'rtl') => {
  const onResizeKeyboard = jest.fn();
  render(
    <div style={{ direction }}>
      <Sidebar
        links={[]}
        expanded
        width={400}
        minWidth={360}
        maxWidth={600}
        onCollapse={jest.fn()}
        onExpand={jest.fn()}
        onLeaveInsights={jest.fn()}
        switchToHistory={false}
        onResizeStart={jest.fn()}
        onResizeKeyboard={onResizeKeyboard}
      />
    </div>,
  );
  const handle = screen.getByRole('separator');
  handle.style.direction = direction;
  return { handle, onResizeKeyboard };
};

describe('Sidebar resize handle keyboard', () => {
  it('grows on ArrowRight and shrinks on ArrowLeft in LTR', () => {
    const { handle, onResizeKeyboard } = renderSidebar('ltr');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(onResizeKeyboard.mock.calls).toEqual([['grow'], ['shrink']]);
  });

  it('grows on ArrowLeft and shrinks on ArrowRight in RTL', () => {
    const { handle, onResizeKeyboard } = renderSidebar('rtl');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(onResizeKeyboard.mock.calls).toEqual([['grow'], ['shrink']]);
  });

  it('ignores other keys', () => {
    const { handle, onResizeKeyboard } = renderSidebar('rtl');
    fireEvent.keyDown(handle, { key: 'ArrowUp' });
    expect(onResizeKeyboard).not.toHaveBeenCalled();
  });
});

describe('createResizeMeasure', () => {
  const mount = (direction: 'ltr' | 'rtl', left: number, right: number) => {
    const aside = document.createElement('aside');
    const handle = document.createElement('div');
    handle.style.direction = direction;
    aside.append(handle);
    jest
      .spyOn(aside, 'getBoundingClientRect')
      .mockReturnValue({ left, right, top: 0, bottom: 0, width: right - left } as DOMRect);
    return handle;
  };

  it('measures from the left edge in LTR', () => {
    const measure = createResizeMeasure(mount('ltr', 0, 400));
    expect(measure(450)).toBe(450);
  });

  it('measures from the right edge in RTL, so dragging left grows the sidebar', () => {
    const measure = createResizeMeasure(mount('rtl', 1040, 1440));
    expect(measure(990)).toBe(450);
    expect(measure(1100)).toBe(340);
  });
});
