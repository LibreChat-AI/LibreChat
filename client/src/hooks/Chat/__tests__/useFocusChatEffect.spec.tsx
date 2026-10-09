const mockNavigate = jest.fn();
const mockTextAreaRef = { current: { focus: jest.fn() } };
let mockLog: jest.SpyInstance;

jest.mock('react-router-dom', () => ({
  useLocation: jest.fn(),
  useNavigate: jest.fn(),
}));

import { renderHook } from '@testing-library/react';
import { useLocation, useNavigate } from 'react-router-dom';
import { requestChatFocus, consumeChatFocus, logger } from '~/utils';
import useFocusChatEffect from '../useFocusChatEffect';

const mockDesktopMedia = () => {
  window.matchMedia = jest.fn().mockImplementation((query) => ({
    matches: query === '(hover: hover)',
    media: '',
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }));
};

const mockTouchMedia = () => {
  window.matchMedia = jest.fn().mockImplementation((query) => ({
    matches: query === '(pointer: coarse)',
    media: '',
    onchange: null,
    addListener: jest.fn(),
    removeListener: jest.fn(),
    addEventListener: jest.fn(),
    removeEventListener: jest.fn(),
    dispatchEvent: jest.fn(),
  }));
};

describe('useFocusChatEffect', () => {
  beforeEach(() => {
    mockLog = jest.spyOn(logger, 'log').mockImplementation(() => {});
    jest.clearAllMocks();
    consumeChatFocus();
    (useNavigate as jest.Mock).mockReturnValue(mockNavigate);
    mockDesktopMedia();
    (useLocation as jest.Mock).mockReturnValue({
      key: 'entry-1',
      pathname: '/c/new',
      search: '',
      state: null,
    });
  });

  test('focuses the textarea when a chat focus was requested before navigation', () => {
    requestChatFocus();

    renderHook(() => useFocusChatEffect(mockTextAreaRef as any));

    expect(mockTextAreaRef.current.focus).toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(mockLog).toHaveBeenCalled();
  });

  test('does not focus when no chat focus was requested', () => {
    renderHook(() => useFocusChatEffect(mockTextAreaRef as any));

    expect(mockTextAreaRef.current.focus).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  test('leaves the request pending when textAreaRef.current is null', () => {
    requestChatFocus();
    const nullTextAreaRef = { current: null };

    renderHook(() => useFocusChatEffect(nullTextAreaRef as any));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(consumeChatFocus()).toBe(true);
  });

  test('consumes the request without focusing on touchscreen devices', () => {
    mockTouchMedia();
    requestChatFocus();

    renderHook(() => useFocusChatEffect(mockTextAreaRef as any));

    expect(mockTextAreaRef.current.focus).not.toHaveBeenCalled();
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(consumeChatFocus()).toBe(false);
  });

  test('consumes the request exactly once across navigations', () => {
    requestChatFocus();

    const { rerender } = renderHook(() => useFocusChatEffect(mockTextAreaRef as any));
    expect(mockTextAreaRef.current.focus).toHaveBeenCalledTimes(1);

    (useLocation as jest.Mock).mockReturnValue({
      key: 'entry-2',
      pathname: '/c/abc',
      search: '',
      state: null,
    });
    rerender();

    expect(mockTextAreaRef.current.focus).toHaveBeenCalledTimes(1);
  });

  test('focuses again when a new request precedes the next navigation', () => {
    requestChatFocus();

    const { rerender } = renderHook(() => useFocusChatEffect(mockTextAreaRef as any));
    expect(mockTextAreaRef.current.focus).toHaveBeenCalledTimes(1);

    requestChatFocus();
    (useLocation as jest.Mock).mockReturnValue({
      key: 'entry-2',
      pathname: '/c/abc',
      search: '',
      state: null,
    });
    rerender();

    expect(mockTextAreaRef.current.focus).toHaveBeenCalledTimes(2);
  });
});
