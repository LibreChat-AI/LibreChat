import React from 'react';
import { RecoilRoot } from 'recoil';
import { renderHook } from '@testing-library/react';
import type { FileConfigInput } from 'librechat-data-provider';
import type { ReactNode } from 'react';
import useClientResize from '../useClientResize';

let mockAdminConfig: FileConfigInput | undefined;
let mockConfigIsSuccess = true;
let mockConfigIsError = false;
let mockConfigIsPaused = false;

jest.mock('~/data-provider', () => ({
  useGetFileConfig: <T,>({ select }: { select: (data: unknown) => T }) => ({
    data: select(mockAdminConfig),
    isError: mockConfigIsError,
    isPaused: mockConfigIsPaused,
    isSuccess: mockConfigIsSuccess,
  }),
}));

const wrapper = ({ children }: { children: ReactNode }) => <RecoilRoot>{children}</RecoilRoot>;

const setUserPreference = (value: boolean) =>
  localStorage.setItem('clientImageResize', JSON.stringify(value));

describe('useClientResize', () => {
  beforeEach(() => {
    localStorage.clear();
    mockAdminConfig = undefined;
    mockConfigIsSuccess = true;
    mockConfigIsError = false;
    mockConfigIsPaused = false;
  });

  it('keeps resizing off until the file config resolves', () => {
    mockConfigIsSuccess = false;
    setUserPreference(true);

    const { result } = renderHook(() => useClientResize(), { wrapper });

    expect(result.current.isEnabled).toBe(false);
    expect(result.current.isConfigPending).toBe(true);
  });

  it('reports the config as unavailable when the request errors', () => {
    mockConfigIsSuccess = false;
    mockConfigIsError = true;
    setUserPreference(true);

    const { result } = renderHook(() => useClientResize(), { wrapper });

    expect(result.current.isConfigPending).toBe(false);
    expect(result.current.isConfigUnavailable).toBe(true);
    expect(result.current.isEnabled).toBe(false);
  });

  it('does not report the config as unavailable once it resolves', () => {
    setUserPreference(true);

    const { result } = renderHook(() => useClientResize(), { wrapper });

    expect(result.current.isConfigUnavailable).toBe(false);
    expect(result.current.isEnabled).toBe(true);
  });

  it('releases uploads when the file config request errors', async () => {
    mockConfigIsSuccess = false;
    const { result, rerender } = renderHook(() => useClientResize(), { wrapper });
    let waitFinished = false;
    const pendingWait = result.current.waitForConfig().then(() => {
      waitFinished = true;
    });

    await Promise.resolve();
    expect(waitFinished).toBe(false);

    mockConfigIsError = true;
    rerender();
    await pendingWait;

    expect(result.current.isConfigPending).toBe(false);
    expect(waitFinished).toBe(true);
  });

  it('does not block uploads when the file config request is paused offline', async () => {
    mockConfigIsSuccess = false;
    mockConfigIsPaused = true;
    const { result } = renderHook(() => useClientResize(), { wrapper });

    await expect(result.current.waitForConfig()).resolves.toBeUndefined();
    expect(result.current.isConfigPending).toBe(false);
  });

  it('fails open after a bounded wait when the file config request never settles', async () => {
    jest.useFakeTimers();
    try {
      mockConfigIsSuccess = false;
      const { result } = renderHook(() => useClientResize(), { wrapper });
      let waitFinished = false;
      const pendingWait = result.current.waitForConfig().then(() => {
        waitFinished = true;
      });

      await Promise.resolve();
      expect(waitFinished).toBe(false);

      jest.advanceTimersByTime(10_000);
      await pendingWait;

      expect(waitFinished).toBe(true);
      await expect(result.current.waitForConfig()).resolves.toBeUndefined();
    } finally {
      jest.useRealTimers();
    }
  });

  describe('without an admin-configured value', () => {
    it('follows the user setting when it is off', () => {
      setUserPreference(false);
      const { result } = renderHook(() => useClientResize(), { wrapper });

      expect(result.current.isEnabled).toBe(false);
      expect(result.current.isEnforced).toBe(false);
    });

    it('follows the user setting when it is on', () => {
      setUserPreference(true);
      const { result } = renderHook(() => useClientResize(), { wrapper });

      expect(result.current.isEnabled).toBe(true);
      expect(result.current.isEnforced).toBe(false);
    });

    it('defaults to off when the user has no stored setting', () => {
      const { result } = renderHook(() => useClientResize(), { wrapper });

      expect(result.current.isEnabled).toBe(false);
    });
  });

  describe('with an admin-configured value', () => {
    it('overrides a user setting that is on', () => {
      mockAdminConfig = { clientImageResize: { enabled: false } };
      setUserPreference(true);
      const { result } = renderHook(() => useClientResize(), { wrapper });

      expect(result.current.isEnabled).toBe(false);
      expect(result.current.isEnforced).toBe(true);
    });

    it('overrides a user setting that is off', () => {
      mockAdminConfig = { clientImageResize: { enabled: true } };
      setUserPreference(false);
      const { result } = renderHook(() => useClientResize(), { wrapper });

      expect(result.current.isEnabled).toBe(true);
      expect(result.current.isEnforced).toBe(true);
    });

    it('applies resize parameters while leaving the toggle to the user', () => {
      mockAdminConfig = { clientImageResize: { maxWidth: 1024, quality: 0.8 } };
      setUserPreference(true);
      const { result } = renderHook(() => useClientResize(), { wrapper });

      expect(result.current.isEnabled).toBe(true);
      expect(result.current.isEnforced).toBe(false);
      expect(result.current.config.maxWidth).toBe(1024);
      expect(result.current.config.quality).toBe(0.8);
    });

    it.each(['maxWidth', 'maxHeight'] as const)(
      'keeps resizing off when the admin config has a non-positive %s',
      (dimension) => {
        mockAdminConfig = { clientImageResize: { enabled: true, [dimension]: 0 } };
        const { result } = renderHook(() => useClientResize(), { wrapper });

        expect(result.current.isEnabled).toBe(false);
      },
    );
  });

  it('returns the original file untouched while disabled', async () => {
    mockAdminConfig = { clientImageResize: { enabled: false } };
    setUserPreference(true);
    const { result } = renderHook(() => useClientResize(), { wrapper });

    const file = new File(['x'], 'photo.jpg', { type: 'image/jpeg' });
    const outcome = await result.current.resizeImageIfNeeded(file);

    expect(outcome.resized).toBe(false);
    expect(outcome.file).toBe(file);
  });
});
