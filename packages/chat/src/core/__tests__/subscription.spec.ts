import type {
  TMessage,
  ChatEvent,
  TSubmission,
  ChatTransport,
  ChatTransportOptions,
} from 'librechat-data-provider';
import type { PageVisibility, SubscriptionTarget, StreamStatusResponse } from '../resumable';
import { ResumableRun, ResumableSubscription } from '../resumable';
import { createScheduler } from '../__fixtures__/resumable';

const createVisibility = () => {
  let visible = true;
  const listeners = new Set<() => void>();
  const visibility: PageVisibility = {
    isVisible: () => visible,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const show = () => {
    visible = true;
    listeners.forEach((listener) => listener());
  };
  return { visibility, show, listeners };
};

const submission = {
  userMessage: { messageId: 'u-1', conversationId: 'c-1' } as TMessage,
  initialResponse: { messageId: 'u-1_', conversationId: 'c-1' } as TMessage,
  conversation: { conversationId: 'c-1' },
} as TSubmission;

const setup = (overrides: Partial<SubscriptionTarget> = {}) => {
  const clock = createScheduler();
  const page = createVisibility();
  const run = new ResumableRun(clock.scheduler);
  const fetchStatus = jest.fn<Promise<StreamStatusResponse>, [string]>();
  const subscribe = jest.fn<void, [SubscriptionTarget]>();
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const target: SubscriptionTarget = {
    streamId: 'c-1',
    submission,
    isResume: false,
    generationCreatedAt: 2000,
    generationProtocolVersion: 2,
    ...overrides,
  };
  run.submission = target.submission;
  const sub = new ResumableSubscription(
    run,
    { logger, visibility: page.visibility, fetchStatus, subscribe },
    target,
  );
  return { run, sub, clock, page, fetchStatus, subscribe };
};

describe('ResumableSubscription', () => {
  it('is current only while it holds the pane, its submission and its lifecycle', () => {
    const controller = new AbortController();
    const { run, sub } = setup({ signal: controller.signal });
    expect(sub.isCurrent()).toBe(false);
    sub.claim();
    expect(sub.isCurrent()).toBe(true);

    sub.replaceSubmission({ ...submission, isRegenerate: true });
    expect(run.submission).toBe(sub.submission);
    expect(sub.isCurrent()).toBe(true);

    run.submission = submission;
    expect(sub.isCurrent()).toBe(false);
    run.submission = sub.submission;
    controller.abort();
    expect(sub.isCurrent()).toBe(false);
  });

  it('builds the stream route with the resume cursor and generation fence', () => {
    const { sub } = setup({ streamId: 'c 1', isResume: true });
    const url = new URL(sub.url(), 'http://localhost');
    expect(url.pathname).toBe('/api/agents/chat/stream/c%201');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      resume: 'true',
      generationCreatedAt: '2000',
      generationProtocolVersion: '2',
    });
  });

  it('routes connection events to their handlers', () => {
    const { sub } = setup();
    let options: ChatTransportOptions | undefined;
    const transport = {
      send: jest.fn(),
      reconnectToStream: jest.fn((_request, opts: ChatTransportOptions) => {
        options = opts;
        return { closed: false };
      }),
    } as ChatTransport;
    const handlers = {
      onOpen: jest.fn(),
      onFrame: jest.fn(),
      onFailure: jest.fn(),
      onClose: jest.fn(),
    };
    sub.connect(transport, handlers);

    const emit = (event: ChatEvent) => options?.onEvent(event);
    emit({ type: 'open' } as ChatEvent);
    emit({ type: 'error', status: 0 });
    emit({ type: 'abort' });
    emit({ type: 'title', data: { event: 'title', data: { title: 't' } } } as ChatEvent);
    expect(handlers.onOpen).toHaveBeenCalledTimes(1);
    expect(handlers.onFailure).toHaveBeenCalledWith({ type: 'error', status: 0 });
    expect(handlers.onClose).toHaveBeenCalledTimes(1);
    expect(handlers.onFrame).toHaveBeenCalledTimes(1);
    expect(transport.reconnectToStream).toHaveBeenCalledWith(
      expect.objectContaining({ headers: { 'X-LibreChat-Generation-Protocol': '2' } }),
      expect.objectContaining({ signal: sub.controller.signal }),
    );
  });

  it('re-attaches after a delay only while it is still current', () => {
    const { run, sub, clock, subscribe } = setup();
    sub.claim();
    sub.scheduleReattach(1000);
    clock.advance(999);
    expect(subscribe).not.toHaveBeenCalled();
    clock.advance(1);
    expect(subscribe).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'c-1', isResume: true, generationCreatedAt: 2000 }),
    );

    sub.scheduleReattach(1000, 'c-2', 3000);
    run.stream = new AbortController();
    clock.advance(1000);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('re-attaches on foreground when the connection closed while hidden', () => {
    const { run, sub, page, subscribe } = setup();
    sub.claim();
    sub.connection = { closed: true };
    sub.watchForeground();
    run.reconnectAttempt = 0;
    page.show();
    expect(sub.controller.signal.aborted).toBe(true);
    expect(run.reconnectAttempt).toBe(1);
    expect(subscribe).toHaveBeenCalledWith(expect.objectContaining({ isResume: true }));
  });

  it('re-attaches on foreground when the status proves an open connection terminal', async () => {
    const { sub, page, fetchStatus, subscribe } = setup();
    sub.claim();
    sub.connection = { closed: false };
    sub.watchForeground();
    fetchStatus.mockResolvedValueOnce({ active: true, createdAt: 2000 });
    page.show();
    await new Promise((resolve) => setImmediate(resolve));
    expect(subscribe).not.toHaveBeenCalled();

    fetchStatus.mockResolvedValueOnce({ active: false, createdAt: 2000 });
    page.show();
    await new Promise((resolve) => setImmediate(resolve));
    expect(fetchStatus).toHaveBeenLastCalledWith('c-1');
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it('keeps one foreground listener per pane', () => {
    const { run, sub, page } = setup();
    sub.watchForeground();
    const second = new ResumableSubscription(run, sub.host, {
      streamId: 'c-1',
      submission,
      isResume: true,
      generationProtocolVersion: 2,
    });
    second.watchForeground();
    expect(page.listeners.size).toBe(1);
  });
});

describe('ResumableRun', () => {
  it('drops the cleared edit prefix only when a new generation binds', () => {
    const run = new ResumableRun(createScheduler().scheduler);
    run.bindPrefixState('gen-1');
    run.editPrefixCleared = true;
    run.bindPrefixState('gen-1');
    expect(run.editPrefixCleared).toBe(true);
    run.bindPrefixState('gen-2');
    expect(run.editPrefixCleared).toBe(false);
  });

  it('clears a pending reattach', () => {
    const clock = createScheduler();
    const run = new ResumableRun(clock.scheduler);
    run.reconnectTimeout = clock.scheduler.setTimeout(() => undefined, 1000);
    run.clearReconnectTimeout();
    expect(run.reconnectTimeout).toBeNull();
    expect(clock.pending()).toBe(0);
  });
});
