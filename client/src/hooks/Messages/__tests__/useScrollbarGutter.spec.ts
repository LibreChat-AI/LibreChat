import { renderHook } from '@testing-library/react';
import useScrollbarGutter, { SCROLLBAR_GUTTER_PROPERTY } from '../useScrollbarGutter';

/** jsdom reports 0 for both widths, so the band has to be posed by hand. */
const scrollContainer = ({ offsetWidth, clientWidth }: Record<string, number>) => {
  const element = document.createElement('div');
  Object.defineProperty(element, 'offsetWidth', { value: offsetWidth, configurable: true });
  Object.defineProperty(element, 'clientWidth', { value: clientWidth, configurable: true });
  return { current: element };
};

describe('useScrollbarGutter', () => {
  afterEach(() => {
    document.documentElement.style.removeProperty(SCROLLBAR_GUTTER_PROPERTY);
  });

  it('publishes the band the container actually holds back', () => {
    renderHook(() => useScrollbarGutter(scrollContainer({ offsetWidth: 800, clientWidth: 785 })));

    expect(document.documentElement.style.getPropertyValue(SCROLLBAR_GUTTER_PROPERTY)).toBe('15px');
  });

  /* An overlay scrollbar reserves nothing, so the column it aligns to must not
     be pushed in by the WebKit token either. */
  it('publishes zero when the scrollbar is an overlay', () => {
    renderHook(() => useScrollbarGutter(scrollContainer({ offsetWidth: 800, clientWidth: 800 })));

    expect(document.documentElement.style.getPropertyValue(SCROLLBAR_GUTTER_PROPERTY)).toBe('0px');
  });

  it('leaves the measurement in place for other threads when one unmounts', () => {
    const { unmount } = renderHook(() =>
      useScrollbarGutter(scrollContainer({ offsetWidth: 800, clientWidth: 785 })),
    );

    unmount();

    expect(document.documentElement.style.getPropertyValue(SCROLLBAR_GUTTER_PROPERTY)).toBe('15px');
  });

  it('does nothing before the container mounts', () => {
    renderHook(() => useScrollbarGutter({ current: null }));

    expect(document.documentElement.style.getPropertyValue(SCROLLBAR_GUTTER_PROPERTY)).toBe('');
  });
});
