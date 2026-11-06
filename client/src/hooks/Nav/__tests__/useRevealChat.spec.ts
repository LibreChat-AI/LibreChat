import { renderHook } from '@testing-library/react';
import useRevealChat from '../useRevealChat';

let mockIsDrawer = false;
const mockSetSidebarOpen = jest.fn();

jest.mock('../useDrawerViewport', () => ({
  __esModule: true,
  default: () => mockIsDrawer,
}));

jest.mock('../useSidebarToggle', () => ({
  __esModule: true,
  default: () => ({ setSidebarOpen: mockSetSidebarOpen, toggleSidebar: jest.fn() }),
}));

describe('useRevealChat', () => {
  beforeEach(() => {
    mockSetSidebarOpen.mockClear();
  });

  it('closes the drawer first and starts the chat on the slide in drawer mode', () => {
    mockIsDrawer = true;
    const start = jest.fn();
    const { result } = renderHook(() => useRevealChat());

    result.current(start);

    expect(mockSetSidebarOpen).toHaveBeenCalledTimes(1);
    expect(mockSetSidebarOpen).toHaveBeenCalledWith(false, start);
    expect(start).not.toHaveBeenCalled();
  });

  it('starts the chat at once and leaves the sidebar alone on the wide layout', () => {
    mockIsDrawer = false;
    const start = jest.fn();
    const { result } = renderHook(() => useRevealChat());

    result.current(start);

    expect(start).toHaveBeenCalledTimes(1);
    expect(mockSetSidebarOpen).not.toHaveBeenCalled();
  });
});
