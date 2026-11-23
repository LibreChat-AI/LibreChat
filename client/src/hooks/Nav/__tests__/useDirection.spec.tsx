import { act, renderHook } from '@testing-library/react';
import useDirection, { inlineSide, isRtlElement } from '../useDirection';

afterEach(() => {
  document.documentElement.removeAttribute('dir');
});

describe('useDirection', () => {
  it('follows the dir attribute on the document element', async () => {
    const { result } = renderHook(() => useDirection());
    expect(result.current).toBe('ltr');

    await act(async () => {
      document.documentElement.dir = 'rtl';
    });
    expect(result.current).toBe('rtl');

    await act(async () => {
      document.documentElement.dir = 'ltr';
    });
    expect(result.current).toBe('ltr');
  });
});

describe('inlineSide', () => {
  it('maps logical edges to physical sides', () => {
    expect(inlineSide('ltr', 'end')).toBe('right');
    expect(inlineSide('ltr', 'start')).toBe('left');
    expect(inlineSide('rtl', 'end')).toBe('left');
    expect(inlineSide('rtl', 'start')).toBe('right');
  });
});

describe('isRtlElement', () => {
  it('reads the element, so an LTR island inside RTL stays LTR', () => {
    const island = document.createElement('div');
    island.style.direction = 'ltr';
    const rtl = document.createElement('div');
    rtl.style.direction = 'rtl';
    expect(isRtlElement(island)).toBe(false);
    expect(isRtlElement(rtl)).toBe(true);
    expect(isRtlElement(null)).toBe(false);
  });
});
