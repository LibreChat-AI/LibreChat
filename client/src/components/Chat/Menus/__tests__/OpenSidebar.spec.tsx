import React from 'react';
import { act, render, screen, fireEvent } from '@testing-library/react';
import OpenSidebar, { CLOSE_SIDEBAR_ID, OPEN_SIDEBAR_ID } from '../OpenSidebar';
import useSidebarToggle from '~/hooks/Nav/useSidebarToggle';

jest.mock('~/hooks', () => ({ useLocalize: () => (key: string) => key }));
jest.mock('~/hooks/useKeyboardShortcuts', () => ({
  useShortcutHint: () => '',
  useShortcutAriaKey: () => '',
}));
jest.mock('~/hooks/Nav/useSidebarToggle', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('@librechat/client', () => ({
  Button: ({
    children,
    size: _size,
    variant: _variant,
    ...props
  }: React.ComponentProps<'button'> & {
    size?: string;
    variant?: string;
  }) => <button {...props}>{children}</button>,
  TooltipAnchor: ({ render: trigger }: { render: React.ReactNode }) => trigger,
  Sidebar: () => null,
}));

const setSidebarOpen = jest.fn();

function setup() {
  render(<OpenSidebar />);
  const opener = screen.getByTestId(OPEN_SIDEBAR_ID);
  const close = document.createElement('button');
  close.id = CLOSE_SIDEBAR_ID;
  const search = document.createElement('input');
  document.body.append(close, search);
  opener.focus();
  fireEvent.click(opener);
  return { opener, close, search };
}

function finishDelay() {
  act(() => jest.advanceTimersByTime(250));
}

describe('desktop sidebar focus fallback', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    setSidebarOpen.mockReturnValue('none');
    jest.mocked(useSidebarToggle).mockReturnValue({ setSidebarOpen, toggleSidebar: jest.fn() });
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    document.body.replaceChildren();
  });

  it('preserves deliberate focus during the delay', () => {
    const { search } = setup();
    search.focus();
    finishDelay();
    expect(search).toHaveFocus();
  });

  it('hands focus to the close button when the opener retains focus', () => {
    const { close } = setup();
    finishDelay();
    expect(close).toHaveFocus();
    expect(setSidebarOpen).toHaveBeenCalledWith(true);
  });

  it('hands focus to the close button when focus falls back to body', () => {
    const { opener, close } = setup();
    opener.blur();
    expect(document.body).toHaveFocus();
    finishDelay();
    expect(close).toHaveFocus();
  });

  it('does nothing when the close button no longer exists', () => {
    const { opener, close } = setup();
    close.remove();
    finishDelay();
    expect(opener).toHaveFocus();
  });

  it.each(['slide', 'snap'])('leaves mobile %s focus to the drawer', (mode) => {
    setSidebarOpen.mockReturnValue(mode);
    const { opener } = setup();
    finishDelay();
    expect(opener).toHaveFocus();
  });
});
