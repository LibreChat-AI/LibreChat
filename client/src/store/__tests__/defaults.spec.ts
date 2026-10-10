import { createStore } from 'jotai';
import { snapshot_UNSTABLE } from 'recoil';
import type { RecoilState } from 'recoil';
import settings from '../settings';

const readRecoil = <T>(atom: RecoilState<T>): T =>
  snapshot_UNSTABLE().getLoadable(atom).valueOrThrow();

/**
 * The Jotai atom reads storage once, when its module is evaluated (as on page
 * load), so each case seeds storage first and then loads a fresh copy.
 */
const readAutoScroll = (): boolean => {
  let value = false;
  jest.isolateModules(() => {
    const { autoScrollAtom } = jest.requireActual<typeof import('../autoScroll')>('../autoScroll');
    value = createStore().get(autoScrollAtom);
  });
  return value;
};

describe('preference defaults with nothing persisted', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('adds a newline on Enter instead of sending', () => {
    expect(readRecoil(settings.enterToSend)).toBe(false);
  });

  it('collapses long user messages', () => {
    expect(readRecoil(settings.collapseLongUserMessages)).toBe(true);
  });

  it('resizes images before upload', () => {
    expect(readRecoil(settings.clientImageResize)).toBe(true);
  });

  it('scrolls to the latest message on chat open', () => {
    expect(readAutoScroll()).toBe(true);
  });
});

/** Guards: a choice saved under the old defaults survives the change. */
describe('persisted preferences', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('keeps a saved Enter to send', () => {
    localStorage.setItem('enterToSend', JSON.stringify(true));

    expect(readRecoil(settings.enterToSend)).toBe(true);
  });

  it('keeps a saved opt-out of collapsing', () => {
    localStorage.setItem('collapseLongUserMessages', JSON.stringify(false));

    expect(readRecoil(settings.collapseLongUserMessages)).toBe(false);
  });

  it('keeps a saved opt-out of resizing', () => {
    localStorage.setItem('clientImageResize', JSON.stringify(false));

    expect(readRecoil(settings.clientImageResize)).toBe(false);
  });

  it('keeps a saved opt-out of auto-scroll', () => {
    localStorage.setItem('autoScroll', JSON.stringify(false));

    expect(readAutoScroll()).toBe(false);
  });
});
