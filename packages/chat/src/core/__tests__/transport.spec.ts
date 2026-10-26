import { SSE } from 'sse.js';

/**
 * `useResumableSSE` decides that a hidden tab lost its stream by reading the
 * transport's own `readyState`. That only holds because sse.js marks the
 * connection closed on the ordinary XHR `load` path — a response body that
 * simply ends dispatches no error and no abort, so `readyState` is the single
 * observable left. The assumption belongs to the library rather than to our
 * hook, so it is pinned here against the real module instead of a mock.
 */
type XHRListener = (event: { currentTarget: FakeXHR }) => void;

class FakeXHR {
  status = 200;
  responseText = '';
  withCredentials = false;
  aborted = false;
  private readonly listeners: Record<string, XHRListener[]> = {};

  addEventListener(type: string, listener: XHRListener) {
    (this.listeners[type] ??= []).push(listener);
  }

  open() {}
  setRequestHeader() {}
  send() {}

  abort() {
    this.aborted = true;
    this.emit('abort');
  }

  emit(type: string) {
    for (const listener of this.listeners[type] ?? []) {
      listener({ currentTarget: this });
    }
  }
}

describe('sse.js transport contract', () => {
  const OriginalXHR = global.XMLHttpRequest;
  let xhr: FakeXHR;

  beforeEach(() => {
    xhr = new FakeXHR();
    global.XMLHttpRequest = jest.fn(() => xhr) as unknown as typeof XMLHttpRequest;
  });

  afterEach(() => {
    global.XMLHttpRequest = OriginalXHR;
  });

  it('marks the connection closed when the response body ends without a terminal event', () => {
    const sse = new SSE('/api/agents/chat/stream/convo-1', { method: 'GET' });
    const onError = jest.fn();
    const onAbort = jest.fn();
    sse.addEventListener('error', onError);
    sse.addEventListener('abort', onAbort);

    xhr.responseText = 'event: message\ndata: {"created":true}\n\n';
    xhr.emit('progress');
    expect(sse.readyState).not.toBe(SSE.CLOSED);

    /** The intermediary ended the body under a frozen tab: XHR reports an
     *  ordinary load, and sse.js dispatches nothing for it. */
    xhr.emit('load');

    expect(onError).not.toHaveBeenCalled();
    expect(onAbort).not.toHaveBeenCalled();
    expect(sse.readyState).toBe(SSE.CLOSED);
  });

  it('dispatches abort when the user agent cancels an in-flight request', () => {
    const sse = new SSE('/api/agents/chat/stream/convo-1', { method: 'GET' });
    const onAbort = jest.fn();
    sse.addEventListener('abort', onAbort);

    xhr.emit('abort');

    expect(onAbort).toHaveBeenCalledTimes(1);
    expect(sse.readyState).toBe(SSE.CLOSED);
  });
});
