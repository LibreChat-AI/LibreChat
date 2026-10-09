import React from 'react';
import { RecoilRoot } from 'recoil';
import { Provider, createStore } from 'jotai';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { TConversation, TMessage } from 'librechat-data-provider';
import {
  MessagesViewContext,
  type MessagesViewContextValue,
} from '~/Providers/MessagesViewContext';

type MockScrollToBottom = jest.Mock & {
  cancel: jest.Mock;
  flush: jest.Mock;
};

const mockScrollToBottom = jest.fn() as MockScrollToBottom;
mockScrollToBottom.cancel = jest.fn();
mockScrollToBottom.flush = jest.fn();
const mockHandleSmoothToRef = jest.fn();
let mockScrollCallback: (() => void) | undefined;

jest.mock('~/hooks/useScrollToRef', () => ({
  __esModule: true,
  default: ({ callback }: { callback: () => void }) => {
    mockScrollCallback = callback;
    return {
      scrollToRef: mockScrollToBottom,
      handleSmoothToRef: mockHandleSmoothToRef,
    };
  },
}));

jest.mock('../messageLayout', () => ({
  reconcileMessageContentLayout: jest.fn(),
}));

import useMessageScrolling from '../useMessageScrolling';
import { reconcileMessageContentLayout } from '../messageLayout';
import { autoScrollAtom } from '~/store/autoScroll';

const mockReconcileMessageContentLayout = reconcileMessageContentLayout as jest.Mock;

class MockResizeObserver {
  static instances: MockResizeObserver[] = [];

  static reset() {
    MockResizeObserver.instances = [];
  }

  static last(): MockResizeObserver | undefined {
    return MockResizeObserver.instances[MockResizeObserver.instances.length - 1];
  }

  readonly callback: ResizeObserverCallback;
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    MockResizeObserver.instances.push(this);
  }

  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];

  static reset() {
    MockIntersectionObserver.instances = [];
  }

  readonly callback: IntersectionObserverCallback;
  observe = jest.fn();
  unobserve = jest.fn();
  disconnect = jest.fn();
  takeRecords = jest.fn(() => []);

  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    MockIntersectionObserver.instances.push(this);
  }
}

/** Matches the hook's glide fallback, the window in which a landing is still pending. */
const glideWindow = 700;

const originalResizeObserver = global.ResizeObserver;
const originalIntersectionObserver = global.IntersectionObserver;

function setRect(element: HTMLElement, rect: Partial<DOMRect>): void {
  element.getBoundingClientRect = jest.fn(
    () =>
      ({
        x: rect.x ?? 0,
        y: rect.y ?? 0,
        top: rect.top ?? 0,
        left: rect.left ?? 0,
        right: rect.right ?? 0,
        bottom: rect.bottom ?? 0,
        width: rect.width ?? 0,
        height: rect.height ?? 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

const conversation = {
  conversationId: 'conversation-1',
  endpoint: 'openAI',
  model: 'gpt-4',
} as TConversation;

const message = {
  messageId: 'message-1',
  conversationId: conversation.conversationId,
  isCreatedByUser: false,
} as TMessage;

function createContextValue(
  overrides: Partial<MessagesViewContextValue> = {},
): MessagesViewContextValue {
  return {
    conversation,
    conversationId: conversation.conversationId,
    isSubmitting: true,
    abortScroll: false,
    setAbortScroll: jest.fn(),
    ask: jest.fn(),
    regenerate: jest.fn(),
    handleContinue: jest.fn(),
    index: 0,
    latestMessageId: message.messageId,
    latestMessageDepth: 0,
    getMessages: jest.fn(),
    setMessages: jest.fn(),
    ...overrides,
  } as MessagesViewContextValue;
}

function ScrollingHarness({ messagesTree }: { messagesTree?: TMessage[] | null }) {
  const { contentRef, scrollableRef, messagesEndRef, debouncedHandleScroll } =
    useMessageScrolling(messagesTree);

  return (
    <div ref={scrollableRef} onScroll={debouncedHandleScroll} data-testid="scrollable">
      <div ref={contentRef} data-testid="content">
        <div ref={messagesEndRef} data-testid="end" />
      </div>
    </div>
  );
}

function renderScrolling({
  contextOverrides,
  messagesTree,
}: {
  contextOverrides?: Partial<MessagesViewContextValue>;
  messagesTree?: TMessage[] | null;
} = {}) {
  return render(
    <RecoilRoot>
      <MessagesViewContext.Provider value={createContextValue(contextOverrides)}>
        <ScrollingHarness messagesTree={messagesTree} />
      </MessagesViewContext.Provider>
    </RecoilRoot>,
  );
}

describe('useMessageScrolling resize reconciliation', () => {
  beforeEach(() => {
    MockResizeObserver.reset();
    MockIntersectionObserver.reset();
    mockScrollToBottom.mockClear();
    mockScrollToBottom.cancel.mockClear();
    mockScrollToBottom.flush.mockClear();
    mockHandleSmoothToRef.mockClear();
    mockReconcileMessageContentLayout.mockClear();
    mockScrollCallback = undefined;
    (global as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
      MockResizeObserver;
    (
      global as unknown as { IntersectionObserver: typeof MockIntersectionObserver }
    ).IntersectionObserver = MockIntersectionObserver;
  });

  afterEach(() => {
    (global as unknown as { ResizeObserver: typeof ResizeObserver | undefined }).ResizeObserver =
      originalResizeObserver;
    (
      global as unknown as { IntersectionObserver: typeof IntersectionObserver | undefined }
    ).IntersectionObserver = originalIntersectionObserver;
  });

  it('rides the bottom when streaming content resizes and auto-scroll is active', () => {
    renderScrolling();

    const observer = MockResizeObserver.last();
    expect(observer?.observe).toHaveBeenCalledWith(screen.getByTestId('content'));

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 700;

    act(() => {
      observer?.trigger();
    });

    /** Written straight to the element rather than routed through the throttled
     *  scrollIntoView helper, so an answer arriving a few pixels at a time flows
     *  instead of lurching once every throttle window. */
    expect(scrollable.scrollTop).toBe(800);
  });

  it('reconciles message layout after an explicit scroll to bottom', () => {
    renderScrolling();

    const scrollable = screen.getByTestId('scrollable');
    act(() => {
      mockScrollCallback?.();
    });

    expect(mockReconcileMessageContentLayout).toHaveBeenCalledWith(scrollable);
  });

  /**
   * `useMessageProcess` raises the abort flag on any wheel at all, downward ones
   * included, through a throttle whose trailing call lands after the gesture has
   * ended. Gating on it meant scrolling down to the newest word could never resume
   * the ride, while the scroll-to-bottom button, which touches no wheel, always
   * could. Position and direction answer that question instead.
   */
  it('rides the bottom for a reader who is on it, even with the abort flag raised', () => {
    renderScrolling({ contextOverrides: { abortScroll: true } });

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 700;

    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(scrollable.scrollTop).toBe(800);
  });

  it('does not follow resizes after the user scrolls away from the bottom', () => {
    renderScrolling();

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 100;

    fireEvent.scroll(scrollable);

    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  it('judges the first scroll against a real previous position, not against the top', () => {
    const setAbortScroll = jest.fn();
    renderScrolling({ contextOverrides: { setAbortScroll } });

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });

    /** A thread opens at its end, so the reader's first gesture carries a large
     *  positive scrollTop. Measured from 0 it read as a jump down onto the end, and
     *  the reader was re-pinned to the stream they were trying to leave. */
    setAbortScroll.mockClear();
    scrollable.scrollTop = 700;
    fireEvent.scroll(scrollable);

    expect(setAbortScroll).not.toHaveBeenCalled();

    /** With a baseline taken, the same gesture is judged on its real delta. */
    scrollable.scrollTop = 500;
    fireEvent.scroll(scrollable);

    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(scrollable.scrollTop).toBe(500);
  });

  it('obeys the first scroll away from a thread that was placed at its end', () => {
    renderScrolling();

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });

    /** The thread opens at its end without the reader touching it, so the position
     *  it was placed at is what their first gesture has to be judged against. */
    scrollable.scrollTop = 800;
    act(() => {
      mockScrollCallback?.();
    });

    /** One PageUp, and it is the first event the handler sees. A key press buys a
     *  single resize of grace and clears no flag of its own, so if the gesture is
     *  spent taking a baseline the reader is ridden straight back to the end. */
    fireEvent.keyDown(screen.getByTestId('content'), { key: 'PageUp' });
    scrollable.scrollTop = 300;
    fireEvent.scroll(scrollable);

    act(() => {
      MockResizeObserver.last()?.trigger();
      MockResizeObserver.last()?.trigger();
    });

    expect(scrollable.scrollTop).toBe(300);
  });

  it('does not follow the next resize after user interaction inside message content', () => {
    renderScrolling();

    fireEvent.pointerDown(screen.getByTestId('content'));

    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  /**
   * One interaction rarely settles in a single frame: expanding a tool result renders
   * the container, then its contents arrive and grow it again. Only the first resize
   * was credited to the interaction, so the second read the reader as still riding the
   * stream and put them back on the bottom they had just deliberately left.
   */
  it('keeps an interaction that settles over several resizes from re-pinning the reader', () => {
    renderScrolling();

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 800;

    fireEvent.pointerDown(screen.getByTestId('content'));

    /** The expansion renders, which is the resize the interaction is credited with. */
    Object.defineProperty(scrollable, 'scrollHeight', { value: 2000, configurable: true });
    act(() => {
      MockResizeObserver.last()?.trigger();
    });
    expect(scrollable.scrollTop).toBe(800);

    /** Its contents then load. This belongs to the same interaction, not to the stream. */
    Object.defineProperty(scrollable, 'scrollHeight', { value: 2600, configurable: true });
    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(scrollable.scrollTop).toBe(800);
  });

  it('clamps the scroll position back to content after a resize shrink', () => {
    renderScrolling({ contextOverrides: { abortScroll: true } });

    const scrollable = screen.getByTestId('scrollable');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 500, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 450;

    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(scrollable.scrollTop).toBe(300);
    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  /**
   * Sending arms a smooth glide down to the newest word, and the landing re-pins the
   * thread to the bottom. The landing is scheduled for the whole glide window, so a
   * reader who changes their mind and heads up mid-flight was pinned again anyway and
   * dragged back on the next streaming resize.
   */
  it('lets an upward gesture during the send glide beat the pending landing', () => {
    jest.useFakeTimers();
    try {
      const view = render(
        <RecoilRoot>
          <MessagesViewContext.Provider value={createContextValue({ isSubmitting: false })}>
            <ScrollingHarness messagesTree={[message]} />
          </MessagesViewContext.Provider>
        </RecoilRoot>,
      );

      const scrollable = screen.getByTestId('scrollable');
      const scrollTo = jest.fn();
      (scrollable as unknown as { scrollTo: jest.Mock }).scrollTo = scrollTo;
      Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
      scrollable.scrollTop = 0;

      view.rerender(
        <RecoilRoot>
          <MessagesViewContext.Provider value={createContextValue({ isSubmitting: true })}>
            <ScrollingHarness messagesTree={[message]} />
          </MessagesViewContext.Provider>
        </RecoilRoot>,
      );

      expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' });

      /** The reader heads up while the glide is still in flight. */
      scrollable.scrollTop = 400;
      fireEvent.wheel(scrollable, { deltaY: -120 });

      act(() => {
        jest.advanceTimersByTime(glideWindow);
      });

      Object.defineProperty(scrollable, 'scrollHeight', { value: 1200, configurable: true });
      act(() => {
        MockResizeObserver.last()?.trigger();
      });

      expect(scrollable.scrollTop).toBe(400);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A reader who scrolls away during one answer leaves the abort flag raised, and
   * nothing lowers it until the next connection opens, which is after the send has
   * already been seen. Spending the start of the turn on that first pass left the
   * answer the reader had just asked for streaming offscreen.
   */
  it('starts the turn once a stale abort flag clears', () => {
    const view = render(
      <RecoilRoot>
        <MessagesViewContext.Provider value={createContextValue({ isSubmitting: false })}>
          <ScrollingHarness messagesTree={[message]} />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    const scrollable = screen.getByTestId('scrollable');
    const scrollTo = jest.fn();
    (scrollable as unknown as { scrollTo: jest.Mock }).scrollTo = scrollTo;
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 0;

    /** They left the bottom during the previous answer, which is what raised it. */
    fireEvent.wheel(scrollable, { deltaY: -120 });

    view.rerender(
      <RecoilRoot>
        <MessagesViewContext.Provider
          value={createContextValue({ isSubmitting: true, abortScroll: true })}
        >
          <ScrollingHarness messagesTree={[message]} />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    expect(scrollTo).not.toHaveBeenCalled();

    /** The connection opens and lowers the flag. */
    view.rerender(
      <RecoilRoot>
        <MessagesViewContext.Provider
          value={createContextValue({ isSubmitting: true, abortScroll: false })}
        >
          <ScrollingHarness messagesTree={[message]} />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' });
  });

  it('leaves the send glide alone while the answer streams in', () => {
    const view = render(
      <RecoilRoot>
        <MessagesViewContext.Provider value={createContextValue({ isSubmitting: false })}>
          <ScrollingHarness messagesTree={[message]} />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    const scrollable = screen.getByTestId('scrollable');
    const scrollTo = jest.fn();
    (scrollable as unknown as { scrollTo: jest.Mock }).scrollTo = scrollTo;
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 0;

    view.rerender(
      <RecoilRoot>
        <MessagesViewContext.Provider value={createContextValue({ isSubmitting: true })}>
          <ScrollingHarness messagesTree={[message]} />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    expect(scrollTo).toHaveBeenCalledWith({ top: 800, behavior: 'smooth' });

    /** The next delta of the answer arrives while the glide is still travelling. */
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1100, configurable: true });
    view.rerender(
      <RecoilRoot>
        <MessagesViewContext.Provider value={createContextValue({ isSubmitting: true })}>
          <ScrollingHarness messagesTree={[message, message]} />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    /** A plain follow would have written scrollTop outright and killed the animation. */
    expect(scrollable.scrollTop).toBe(0);
  });

  /**
   * Following stands down for the length of the glide, so an answer that arrives
   * while it travels moves the bottom past the target the glide aimed at. Landing
   * has to close that gap, or a short response settles short of its own end.
   */
  it('catches up to the new bottom when the glide lands', () => {
    const view = render(
      <RecoilRoot>
        <MessagesViewContext.Provider value={createContextValue({ isSubmitting: false })}>
          <ScrollingHarness messagesTree={[message]} />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    const scrollable = screen.getByTestId('scrollable');
    (scrollable as unknown as { scrollTo: jest.Mock }).scrollTo = jest.fn();
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });
    scrollable.scrollTop = 0;

    view.rerender(
      <RecoilRoot>
        <MessagesViewContext.Provider value={createContextValue({ isSubmitting: true })}>
          <ScrollingHarness messagesTree={[message]} />
        </MessagesViewContext.Provider>
      </RecoilRoot>,
    );

    /** The whole answer arrives before the glide reports that it landed. */
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1400, configurable: true });
    act(() => {
      fireEvent(scrollable, new Event('scrollend'));
    });

    expect(scrollable.scrollTop).toBe(1200);
  });

  it('does not clamp to rendered content bottom during general resize reconciliation', () => {
    renderScrolling();

    const scrollable = screen.getByTestId('scrollable');
    const content = screen.getByTestId('content');
    Object.defineProperty(scrollable, 'scrollHeight', { value: 1000, configurable: true });
    Object.defineProperty(scrollable, 'clientHeight', { value: 200, configurable: true });

    /** Move away from the end so the reader is left alone, which is the state this
     *  is about: reconciliation must not drag them to the rendered content bottom. */
    scrollable.scrollTop = 900;
    fireEvent.scroll(scrollable);
    scrollable.scrollTop = 700;
    fireEvent.scroll(scrollable);

    setRect(scrollable, { top: 0, bottom: 200, height: 200 });
    setRect(content, { top: -700, bottom: -200, height: 500 });

    act(() => {
      MockResizeObserver.last()?.trigger();
    });

    expect(scrollable.scrollTop).toBe(700);
    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });
});

describe('useMessageScrolling navigation landing', () => {
  const treeFor = (conversationId: string): TMessage[] => [
    { ...message, conversationId } as TMessage,
  ];

  const harness = (
    store: ReturnType<typeof createStore>,
    conversationId: string,
    messagesTree: TMessage[] | null,
  ) => (
    <RecoilRoot>
      <Provider store={store}>
        <MessagesViewContext.Provider
          value={createContextValue({
            isSubmitting: false,
            conversation: { ...conversation, conversationId } as TConversation,
            conversationId,
          })}
        >
          <ScrollingHarness messagesTree={messagesTree} />
        </MessagesViewContext.Provider>
      </Provider>
    </RecoilRoot>
  );

  function renderLanding(
    conversationId: string,
    messagesTree: TMessage[] | null,
    autoScroll = true,
  ) {
    const store = createStore();
    store.set(autoScrollAtom, autoScroll);
    const view = render(harness(store, conversationId, messagesTree));
    return {
      ...view,
      rerenderWith: (nextId: string, nextTree: TMessage[] | null) =>
        view.rerender(harness(store, nextId, nextTree)),
    };
  }

  beforeEach(() => {
    MockResizeObserver.reset();
    MockIntersectionObserver.reset();
    mockScrollToBottom.mockClear();
    mockScrollToBottom.cancel.mockClear();
    (global as unknown as { ResizeObserver: typeof MockResizeObserver }).ResizeObserver =
      MockResizeObserver;
    (
      global as unknown as { IntersectionObserver: typeof MockIntersectionObserver }
    ).IntersectionObserver = MockIntersectionObserver;
  });

  afterEach(() => {
    (global as unknown as { ResizeObserver: typeof ResizeObserver | undefined }).ResizeObserver =
      originalResizeObserver;
    (
      global as unknown as { IntersectionObserver: typeof IntersectionObserver | undefined }
    ).IntersectionObserver = originalIntersectionObserver;
  });

  it('waits for the opened conversation to own the rendered rows', () => {
    /** The id reaches the hook commits before the tree does. Landing on the
     *  outgoing thread spends the one scroll this navigation gets, and leaves
     *  the reader at the top of the thread they actually asked for. */
    renderLanding('conversation-2', treeFor('conversation-1'));

    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });

  it('lands once the rendered tree names the opened conversation', () => {
    const { rerenderWith } = renderLanding('conversation-2', treeFor('conversation-1'));
    expect(mockScrollToBottom).not.toHaveBeenCalled();

    rerenderWith('conversation-2', treeFor('conversation-2'));

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('does not re-land on the tree identities a stream mints', () => {
    const { rerenderWith } = renderLanding('conversation-2', treeFor('conversation-2'));
    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);

    /** Every delta writes a fresh array; re-landing on those would haul back a
     *  reader who deliberately scrolled up. */
    rerenderWith('conversation-2', treeFor('conversation-2'));
    rerenderWith('conversation-2', treeFor('conversation-2'));

    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);
  });

  it('lands again for the next conversation opened', () => {
    const { rerenderWith } = renderLanding('conversation-2', treeFor('conversation-2'));
    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);

    rerenderWith('conversation-3', treeFor('conversation-2'));
    expect(mockScrollToBottom).toHaveBeenCalledTimes(1);

    rerenderWith('conversation-3', treeFor('conversation-3'));
    expect(mockScrollToBottom).toHaveBeenCalledTimes(2);
  });

  it('stays put when the setting is off', () => {
    renderLanding('conversation-2', treeFor('conversation-2'), false);

    expect(mockScrollToBottom).not.toHaveBeenCalled();
  });
});
