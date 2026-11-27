import { act, renderHook, waitFor } from '@testing-library/react';
import {
  installCanvasMock,
  registerFakeIcon,
  resetFakeIcons,
  getImageLoadCount,
} from 'test/canvasMock';
import useAdaptiveIcon from '../useAdaptiveIcon';

const BLACK = { width: 24, height: 24, pixels: [0, 0, 0, 0, 0, 0, 0, 255] };
const RED = { width: 24, height: 24, pixels: [255, 0, 0, 255, 0, 0, 0, 0] };

/** Flushes the detector's microtask and settle timer inside `act`. */
const flush = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));

describe('useAdaptiveIcon', () => {
  beforeEach(() => {
    resetFakeIcons();
    installCanvasMock();
  });

  it('does not tint a raster image', () => {
    const { result } = renderHook(() => useAdaptiveIcon('/logo-raster.png'));
    expect(result.current.shouldTint).toBe(false);
  });

  it('tints a monochrome svg once resolved', async () => {
    registerFakeIcon('/mono-1.svg', BLACK);
    const { result } = renderHook(() => useAdaptiveIcon('/mono-1.svg'));
    await waitFor(() => expect(result.current.shouldTint).toBe(true));
  });

  it('does not tint a multi-color svg', async () => {
    registerFakeIcon('/color-1.svg', RED);
    const { result } = renderHook(() => useAdaptiveIcon('/color-1.svg'));
    await flush();
    expect(result.current.shouldTint).toBe(false);
  });

  it('does not tint when the icon fails to load', async () => {
    registerFakeIcon('/broken-1.svg', { width: 24, height: 24, error: true });
    const { result } = renderHook(() => useAdaptiveIcon('/broken-1.svg'));
    await flush();
    expect(result.current.shouldTint).toBe(false);
  });

  it('does not tint when a cross-origin icon taints the canvas', async () => {
    registerFakeIcon('/cross-1.svg', { ...BLACK, taint: true });
    const { result } = renderHook(() => useAdaptiveIcon('/cross-1.svg'));
    await flush();
    expect(result.current.shouldTint).toBe(false);
  });

  it('drops the previous tint immediately when src changes to a raster image', async () => {
    registerFakeIcon('/mono-2.svg', BLACK);
    const { result, rerender } = renderHook(({ src }) => useAdaptiveIcon(src), {
      initialProps: { src: '/mono-2.svg' },
    });
    await waitFor(() => expect(result.current.shouldTint).toBe(true));

    rerender({ src: '/logo-raster-2.png' });
    expect(result.current.shouldTint).toBe(false);
  });

  it('does not leak the previous tint to a new, still-resolving svg', async () => {
    registerFakeIcon('/mono-3.svg', BLACK);
    registerFakeIcon('/pending.svg', { width: 24, height: 24, pending: true });
    const { result, rerender } = renderHook(({ src }) => useAdaptiveIcon(src), {
      initialProps: { src: '/mono-3.svg' },
    });
    await waitFor(() => expect(result.current.shouldTint).toBe(true));

    rerender({ src: '/pending.svg' });
    expect(result.current.shouldTint).toBe(false);
  });

  it('samples the icon once for concurrent instances of the same src', async () => {
    registerFakeIcon('/shared.svg', BLACK);
    const first = renderHook(() => useAdaptiveIcon('/shared.svg'));
    const second = renderHook(() => useAdaptiveIcon('/shared.svg'));
    await waitFor(() => expect(first.result.current.shouldTint).toBe(true));
    await waitFor(() => expect(second.result.current.shouldTint).toBe(true));
    expect(getImageLoadCount()).toBe(1);
  });

  it('reuses a cached verdict for a later instance without re-sampling', async () => {
    registerFakeIcon('/cached.svg', BLACK);
    const first = renderHook(() => useAdaptiveIcon('/cached.svg'));
    await waitFor(() => expect(first.result.current.shouldTint).toBe(true));
    first.unmount();
    const sampledOnce = getImageLoadCount();

    const second = renderHook(() => useAdaptiveIcon('/cached.svg'));
    expect(second.result.current.shouldTint).toBe(true);
    expect(getImageLoadCount()).toBe(sampledOnce);
    await flush();
  });

  describe('explicit monochrome flag', () => {
    it('tints without detection when monochrome is true', () => {
      const { result } = renderHook(() => useAdaptiveIcon('/unregistered.svg', true));
      expect(result.current.shouldTint).toBe(true);
    });

    it('does not tint when monochrome is false, skipping detection', async () => {
      registerFakeIcon('/mono-4.svg', BLACK);
      const { result } = renderHook(() => useAdaptiveIcon('/mono-4.svg', false));
      await flush();
      expect(result.current.shouldTint).toBe(false);
    });

    it('applies the explicit flag to non-svg sources', () => {
      const { result } = renderHook(() => useAdaptiveIcon('/logo-raster.png', true));
      expect(result.current.shouldTint).toBe(true);
    });
  });
});
