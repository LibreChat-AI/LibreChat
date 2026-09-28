import React from 'react';
import { Provider, createStore } from 'jotai';
import { act, render, screen } from '@testing-library/react';
import { composerOverlayCountFamily } from '~/components/Chat/Input/overlay';
import ScrollButton from '../ScrollButton';

jest.mock('~/hooks', () => ({
  useLocalize: () => (key: string) => key,
}));

const CONVO_ID = 'convo-1';
/** `visibilityDebounceRate` in the component, plus the exit transition. */
const VISIBILITY_DEBOUNCE = 150;
const EXIT_TRANSITION = 180;

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  static last(): MockIntersectionObserver {
    const last = MockIntersectionObserver.instances[MockIntersectionObserver.instances.length - 1];
    if (last == null) {
      throw new Error('no IntersectionObserver was created');
    }
    return last;
  }

  callback: IntersectionObserverCallback;
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  takeRecords = jest.fn(() => []);

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }

  trigger(isIntersecting: boolean) {
    this.callback(
      [{ isIntersecting } as IntersectionObserverEntry],
      this as unknown as IntersectionObserver,
    );
  }
}

const originalIO = global.IntersectionObserver;
let jotaiStore = createStore();

function renderButton({ enabled = true }: { enabled?: boolean } = {}) {
  const scrollable = document.createElement('div');
  const messagesEnd = document.createElement('div');
  scrollable.appendChild(messagesEnd);
  return render(
    <Provider store={jotaiStore}>
      <ScrollButton
        conversationId={CONVO_ID}
        enabled={enabled}
        maximizeChatSpace={false}
        scrollableRef={{ current: scrollable }}
        messagesEndRef={{ current: messagesEnd }}
        scrollHandler={jest.fn()}
        onNearBottomChange={jest.fn()}
        overlayHeight={0}
      />
    </Provider>,
  );
}

/** The thread end leaves the viewport and the visibility debounce settles. */
const scrollAway = () =>
  act(() => {
    MockIntersectionObserver.last().trigger(false);
    jest.advanceTimersByTime(VISIBILITY_DEBOUNCE + 1);
  });

const setOpenPanels = (count: number) =>
  act(() => {
    jotaiStore.set(composerOverlayCountFamily(CONVO_ID), count);
  });

const finishExit = () =>
  act(() => {
    jest.advanceTimersByTime(EXIT_TRANSITION + 1);
  });

const button = () => screen.queryByRole('button', { name: 'com_ui_scroll_to_bottom' });

describe('ScrollButton', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    MockIntersectionObserver.instances = [];
    global.IntersectionObserver =
      MockIntersectionObserver as unknown as typeof IntersectionObserver;
    jotaiStore = createStore();
  });

  afterEach(() => {
    global.IntersectionObserver = originalIO;
    jest.useRealTimers();
  });

  it('appears once the thread end scrolls out of view', () => {
    renderButton();
    expect(button()).toBeNull();

    scrollAway();
    expect(button()).toBeInTheDocument();
  });

  /* A pause panel floats up from the composer over the same corner; rather
     than land on its footer, the control leaves the band to the panel. */
  it('stands down while a composer panel is open and returns when it closes', () => {
    renderButton();
    scrollAway();
    expect(button()).toBeInTheDocument();

    setOpenPanels(1);
    finishExit();
    expect(button()).toBeNull();

    setOpenPanels(0);
    expect(button()).toBeInTheDocument();
  });

  it('waits for the last open panel, not the first to close', () => {
    renderButton();
    scrollAway();

    setOpenPanels(2);
    finishExit();
    expect(button()).toBeNull();

    setOpenPanels(1);
    finishExit();
    expect(button()).toBeNull();

    setOpenPanels(0);
    expect(button()).toBeInTheDocument();
  });

  it('does not show a scrolled-up thread under an already open panel', () => {
    setOpenPanels(1);
    renderButton();
    scrollAway();
    expect(button()).toBeNull();
  });

  it('stays hidden when the host preference turns it off', () => {
    renderButton({ enabled: false });
    scrollAway();
    expect(button()).toBeNull();
  });
});
