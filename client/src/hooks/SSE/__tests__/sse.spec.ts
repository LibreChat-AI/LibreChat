import { request } from 'librechat-data-provider';
import type { ChatEvent, TPayload } from 'librechat-data-provider';
import { createSSETransport } from '../transport';

/**
 * Drives the real `sse.js` module through a fake XHR, so the transport is
 * tested against the library's actual framing and lifecycle.
 */
type XHRListener = (event: { currentTarget: FakeXHR }) => void;

class FakeXHR {
  static HEADERS_RECEIVED = 2;
  status = 200;
  readyState = 0;
  response = '';
  responseText = '';
  withCredentials = false;
  headers: Record<string, string> = {};
  body: string | null = null;
  method = '';
  url = '';
  private readonly listeners: Record<string, XHRListener[]> = {};

  addEventListener(type: string, listener: XHRListener) {
    (this.listeners[type] ??= []).push(listener);
  }

  open(method: string, url: string) {
    this.method = method;
    this.url = url;
  }

  setRequestHeader(key: string, value: string) {
    this.headers[key] = value;
  }

  send(body: string | null) {
    this.body = body;
  }

  getAllResponseHeaders() {
    return 'content-type: text/event-stream\r\n';
  }

  abort() {
    this.emit('abort');
  }

  emit(type: string) {
    for (const listener of this.listeners[type] ?? []) {
      listener({ currentTarget: this });
    }
  }

  receiveHeaders() {
    this.readyState = FakeXHR.HEADERS_RECEIVED;
    this.emit('readystatechange');
  }

  write(chunk: string) {
    this.responseText += chunk;
    this.response = this.responseText;
    this.emit('progress');
  }
}

const message = (data: object | string) =>
  `event: message\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;

const turn = {
  server: '/api/assistants/v2/chat',
  payload: { text: 'Hello', conversationId: null, isContinued: false } as TPayload,
};

describe('createSSETransport', () => {
  const OriginalXHR = global.XMLHttpRequest;
  let xhrs: FakeXHR[];
  let events: ChatEvent[];
  let controller: AbortController;

  const current = () => xhrs[xhrs.length - 1];
  const send = (token = 'token-1') =>
    createSSETransport({ token }).send(turn, {
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });

  beforeEach(() => {
    xhrs = [];
    events = [];
    controller = new AbortController();
    const FakeConstructor = jest.fn(() => {
      const xhr = new FakeXHR();
      xhrs.push(xhr);
      return xhr;
    });
    global.XMLHttpRequest = Object.assign(FakeConstructor, {
      HEADERS_RECEIVED: FakeXHR.HEADERS_RECEIVED,
    }) as unknown as typeof XMLHttpRequest;
  });

  afterEach(() => {
    global.XMLHttpRequest = OriginalXHR;
    jest.restoreAllMocks();
  });

  it('posts the payload with the bearer token', () => {
    send();

    expect(current().body).toBe(JSON.stringify(turn.payload));
    expect(current().headers).toEqual({
      'Content-Type': 'application/json',
      Authorization: 'Bearer token-1',
    });
  });

  it('emits open, then created, sync and final frames in wire order', () => {
    send();
    current().receiveHeaders();
    current().write(
      message({ created: true, message: { messageId: 'user-1' } }) +
        message({ sync: true, responseMessage: { messageId: 'response-1' } }) +
        message({ final: true, responseMessage: { messageId: 'response-1' } }),
    );

    expect(events.map((event) => event.type)).toEqual(['open', 'created', 'sync', 'final']);
    expect(events[1]).toEqual({
      type: 'created',
      data: { created: true, message: { messageId: 'user-1' } },
    });
  });

  it('normalizes the named attachment event and the in-band attachment frame alike', () => {
    const attachment = { file_id: 'file-1', filename: 'a.png', type: 'image/png' };
    send();
    current().write(
      `event: attachment\ndata: ${JSON.stringify(attachment)}\n\n` +
        message({ event: 'attachment', data: attachment }),
    );

    expect(events).toEqual([
      { type: 'attachment', data: attachment },
      { type: 'attachment', data: attachment },
    ]);
  });

  it('skips a malformed frame and keeps dispatching the frames behind it', () => {
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    send();
    current().write(
      message('{"created": tru') + message({ final: true, responseMessage: { text: 'done' } }),
    );

    expect(events).toEqual([
      { type: 'final', data: { final: true, responseMessage: { text: 'done' } } },
    ]);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('emits the parsed body of a server error event', () => {
    send();
    current().write(`event: error\ndata: ${JSON.stringify({ text: 'Rate limited' })}\n\n`);

    expect(events).toEqual([{ type: 'error', data: { text: 'Rate limited' } }]);
  });

  it('emits an error with undefined data when the failure body is not JSON', () => {
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    send();
    current().status = 500;
    current().write('Internal Server Error');

    expect(events).toEqual([{ type: 'error', data: undefined }]);
  });

  it('refreshes the token once on a 401 and retries on a new connection', async () => {
    jest.spyOn(request, 'refreshToken').mockResolvedValue({ token: 'token-2' } as never);
    const dispatchTokenUpdated = jest
      .spyOn(request, 'dispatchTokenUpdatedEvent')
      .mockImplementation(() => undefined);
    send();
    current().status = 401;
    current().write('Unauthorized');

    await new Promise(process.nextTick);

    expect(xhrs).toHaveLength(2);
    expect(current().headers.Authorization).toBe('Bearer token-2');
    expect(dispatchTokenUpdated).toHaveBeenCalledWith('token-2');
    expect(events).toEqual([]);
  });

  it('reports a second 401 instead of refreshing again', async () => {
    const refreshToken = jest
      .spyOn(request, 'refreshToken')
      .mockResolvedValue({ token: 'token-2' } as never);
    jest.spyOn(request, 'dispatchTokenUpdatedEvent').mockImplementation(() => undefined);
    jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    send();
    current().status = 401;
    current().write('Unauthorized');
    await new Promise(process.nextTick);

    current().status = 401;
    current().write('Unauthorized');
    await new Promise(process.nextTick);

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(xhrs).toHaveLength(2);
    expect(events).toEqual([{ type: 'error', data: undefined }]);
  });

  it.each([
    ['succeeds', () => Promise.resolve({ token: 'token-2' })],
    ['fails', () => Promise.reject(new Error('refresh failed'))],
  ])(
    'cancels, and stays closed, when aborted while a 401 refresh %s',
    async (_outcome, refresh) => {
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
      jest.spyOn(request, 'refreshToken').mockImplementation(refresh as never);
      const dispatchTokenUpdated = jest
        .spyOn(request, 'dispatchTokenUpdatedEvent')
        .mockImplementation(() => undefined);
      send();
      current().status = 401;
      current().write('Unauthorized');

      controller.abort();
      await new Promise(process.nextTick);

      expect(xhrs).toHaveLength(1);
      expect(dispatchTokenUpdated).not.toHaveBeenCalled();
      expect(events).toEqual([{ type: 'abort' }]);
    },
  );

  it('emits abort when the caller aborts mid-stream, then goes quiet', () => {
    send();
    current().receiveHeaders();
    current().write(message({ created: true, message: {} }));
    const xhr = current();

    controller.abort();
    xhr.write(message({ final: true }));

    expect(events.map((event) => event.type)).toEqual(['open', 'created', 'abort']);
  });

  it('does not emit abort for a stream that already closed', () => {
    send();
    current().write(message({ final: true }));
    current().emit('load');

    controller.abort();

    expect(events.map((event) => event.type)).toEqual(['final']);
  });

  it('never opens a connection for an already-aborted signal', () => {
    controller.abort();
    send();

    expect(xhrs).toHaveLength(0);
    expect(events).toEqual([]);
  });
});

describe('createSSETransport().reconnectToStream', () => {
  const OriginalXHR = global.XMLHttpRequest;
  const stream = {
    url: '/api/agents/chat/stream/convo-1?resume=true',
    headers: { 'X-LibreChat-Generation-Protocol': '2' },
  };
  let xhrs: FakeXHR[];
  let events: ChatEvent[];
  let controller: AbortController;

  const current = () => xhrs[xhrs.length - 1];
  const attach = (token = 'token-1') =>
    createSSETransport({ token }).reconnectToStream(stream, {
      signal: controller.signal,
      onEvent: (event) => events.push(event),
    });

  beforeEach(() => {
    xhrs = [];
    events = [];
    controller = new AbortController();
    const FakeConstructor = jest.fn(() => {
      const xhr = new FakeXHR();
      xhrs.push(xhr);
      return xhr;
    });
    global.XMLHttpRequest = Object.assign(FakeConstructor, {
      HEADERS_RECEIVED: FakeXHR.HEADERS_RECEIVED,
    }) as unknown as typeof XMLHttpRequest;
  });

  afterEach(() => {
    global.XMLHttpRequest = OriginalXHR;
    jest.restoreAllMocks();
  });

  it('attaches with a GET carrying the bearer token and the request headers', () => {
    attach();

    expect(current().method).toBe('GET');
    expect(current().url).toBe(stream.url);
    expect(current().headers).toEqual({
      Authorization: 'Bearer token-1',
      'X-LibreChat-Generation-Protocol': '2',
    });
  });

  it('normalizes the resume snapshot and the frames behind it', () => {
    attach();
    current().receiveHeaders();
    current().write(
      message({ sync: true, resumeState: { runSteps: [] }, pendingEvents: [] }) +
        message({ event: 'attachment', data: { file_id: 'file-1' } }) +
        message({ final: true, reconcile: true, terminalStatus: 'complete' }),
    );

    expect(events).toEqual([
      { type: 'open' },
      { type: 'sync', data: { sync: true, resumeState: { runSteps: [] }, pendingEvents: [] } },
      { type: 'attachment', data: { file_id: 'file-1' } },
      { type: 'final', data: { final: true, reconcile: true, terminalStatus: 'complete' } },
    ]);
  });

  it('emits a server error event with its parsed body and no status', () => {
    attach();
    current().write(`event: error\ndata: ${JSON.stringify({ error: 'failed' })}\n\n`);

    expect(events).toEqual([{ type: 'error', status: undefined, data: { error: 'failed' } }]);
  });

  it('keeps the raw text of a server error event that is not JSON', () => {
    attach();
    current().write('event: error\ndata: service unavailable\n\n');

    expect(events).toEqual([{ type: 'error', status: undefined, data: 'service unavailable' }]);
  });

  it('emits an HTTP failure with its status and no data for a body that is not JSON', () => {
    attach();
    current().status = 404;
    current().write('Not Found');

    expect(events).toEqual([{ type: 'error', status: 404, data: undefined }]);
  });

  it('reports a cancel the caller did not issue as a dropped connection', () => {
    const connection = attach();
    current().receiveHeaders();

    current().abort();

    expect(events).toEqual([{ type: 'open' }, { type: 'error', status: 0 }]);
    expect(connection.closed).toBe(true);
  });

  it('emits abort when the caller closes an open stream, then goes quiet', () => {
    const connection = attach();
    current().receiveHeaders();
    const xhr = current();

    controller.abort();
    xhr.write(message({ final: true }));

    expect(events).toEqual([{ type: 'open' }, { type: 'abort' }]);
    expect(connection.closed).toBe(true);
  });

  it('reports a body that ends before the terminal frame as a dropped connection', () => {
    const connection = attach();
    current().receiveHeaders();
    current().write(message({ created: true, message: {} }));
    expect(connection.closed).toBe(false);

    current().emit('load');

    expect(connection.closed).toBe(true);
    expect(events).toEqual([
      { type: 'open' },
      { type: 'created', data: { created: true, message: {} } },
      { type: 'error', status: 0 },
    ]);
    controller.abort();
    expect(events).toHaveLength(3);
  });

  it('ends quietly once the terminal frame arrived before the body ended', () => {
    attach();
    current().receiveHeaders();
    current().write(message({ final: true, terminalStatus: 'complete' }));

    current().emit('load');

    expect(events.map((event) => event.type)).toEqual(['open', 'final']);
  });

  it('reports a body that ends without carrying any frame', () => {
    attach();
    current().receiveHeaders();

    current().emit('load');

    expect(events).toEqual([{ type: 'open' }, { type: 'error', status: 0 }]);
  });

  it('counts the terminal frame parsed out of the closing chunk', () => {
    attach();
    current().receiveHeaders();
    /** The trailing frame has no blank line yet, so `progress` keeps it buffered
     * and only the closing `load` parses and dispatches it. */
    current().write('data: ' + JSON.stringify({ final: true }) + '\n');

    current().emit('load');

    expect(events.map((event) => event.type)).toEqual(['open', 'final']);
  });

  it('reports a body that ends without the final frame after a 401 reattachment', async () => {
    jest.spyOn(request, 'refreshToken').mockResolvedValue({ token: 'token-2' } as never);
    jest.spyOn(request, 'dispatchTokenUpdatedEvent').mockImplementation(() => undefined);
    attach();
    current().status = 401;
    current().write('Unauthorized');

    await new Promise(process.nextTick);
    current().receiveHeaders();
    current().write(message({ created: true, message: {} }));
    current().emit('load');

    expect(events).toEqual([
      { type: 'open' },
      { type: 'created', data: { created: true, message: {} } },
      { type: 'error', status: 0 },
    ]);
  });

  it('refreshes the token on a 401 and reattaches with the request headers', async () => {
    jest.spyOn(request, 'refreshToken').mockResolvedValue({ token: 'token-2' } as never);
    const dispatchTokenUpdated = jest
      .spyOn(request, 'dispatchTokenUpdatedEvent')
      .mockImplementation(() => undefined);
    attach();
    current().status = 401;
    current().write('Unauthorized');

    await new Promise(process.nextTick);

    expect(dispatchTokenUpdated).toHaveBeenCalledWith('token-2');
    expect(xhrs).toHaveLength(2);
    expect(current().method).toBe('GET');
    expect(current().headers).toEqual({
      Authorization: 'Bearer token-2',
      'X-LibreChat-Generation-Protocol': '2',
    });
    expect(events).toEqual([]);
  });

  it('reports a second 401 instead of refreshing again', async () => {
    const refreshToken = jest
      .spyOn(request, 'refreshToken')
      .mockResolvedValue({ token: 'token-2' } as never);
    jest.spyOn(request, 'dispatchTokenUpdatedEvent').mockImplementation(() => undefined);
    attach();

    for (const _attempt of [1, 2]) {
      current().status = 401;
      current().write('Unauthorized');
      await new Promise(process.nextTick);
    }

    expect(refreshToken).toHaveBeenCalledTimes(1);
    expect(xhrs).toHaveLength(2);
    expect(events).toEqual([{ type: 'error', status: 401, data: undefined }]);
  });

  it('reports the 401 when the token refresh fails', async () => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
    jest.spyOn(request, 'refreshToken').mockRejectedValue(new Error('refresh failed'));
    attach();
    current().status = 401;
    current().write('Unauthorized');

    await new Promise(process.nextTick);

    expect(xhrs).toHaveLength(1);
    expect(events).toEqual([{ type: 'error', status: 401, data: undefined }]);
  });

  it('stays closed when the caller aborts while a 401 refresh is in flight', async () => {
    jest.spyOn(request, 'refreshToken').mockResolvedValue({ token: 'token-2' } as never);
    const dispatchTokenUpdated = jest
      .spyOn(request, 'dispatchTokenUpdatedEvent')
      .mockImplementation(() => undefined);
    attach();
    current().status = 401;
    current().write('Unauthorized');

    controller.abort();
    await new Promise(process.nextTick);

    expect(xhrs).toHaveLength(1);
    expect(dispatchTokenUpdated).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('never opens a connection for an already-aborted signal', () => {
    controller.abort();
    const connection = attach();

    expect(xhrs).toHaveLength(0);
    expect(connection.closed).toBe(true);
    expect(events).toEqual([]);
  });
});
