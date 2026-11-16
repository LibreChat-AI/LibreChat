import { Socket } from 'node:net';
import { IncomingMessage, ServerResponse } from 'node:http';
import type { RequestListener } from 'node:http';

export interface ResponseHttpResult {
  status: number;
  contentType: string;
}

/**
 * An in-process HTTP hop through the real application. Native request/response
 * streams preserve middleware, AsyncLocalStorage, limits and close-based aborts.
 * No identity/configuration from an earlier turn is copied into the next request.
 */
export function dispatchResponseHttp(input: {
  application: RequestListener;
  source: IncomingMessage;
  method: 'GET' | 'POST';
  path: string;
  maxBufferedBytes: number;
  body?: unknown;
  initialize?: (request: IncomingMessage) => void;
  onBody: (chunk: Buffer, result: ResponseHttpResult) => Promise<void> | void;
}): { done: Promise<ResponseHttpResult>; abort: () => void } {
  let resolve: (result: ResponseHttpResult) => void;
  let reject: (error: Error) => void;
  const done = new Promise<ResponseHttpResult>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  let headers = Buffer.alloc(0);
  let started = false;
  let finished = false;
  const socket = new Socket({ allowHalfOpen: true, readable: true, writable: true });
  const source = input.source.socket;
  for (const field of ['remoteAddress', 'remotePort', 'remoteFamily', 'encrypted'] as const) {
    Object.defineProperty(socket, field, {
      get: () => (field in source ? Reflect.get(source, field) : undefined),
    });
  }
  socket._read = () => {};
  const request = new IncomingMessage(socket);
  request.method = input.method;
  request.url = input.path;
  request.httpVersion = '1.1';
  request.httpVersionMajor = 1;
  request.httpVersionMinor = 1;
  request.headers = { ...input.source.headers };
  for (const key of Object.keys(request.headers)) {
    if (
      key.startsWith('sec-websocket-') ||
      [
        'upgrade',
        'connection',
        'transfer-encoding',
        'accept-encoding',
        'content-length',
        'content-type',
        'content-encoding',
        'expect',
        'keep-alive',
        'proxy-connection',
        'te',
        'trailer',
        'idempotency-key',
        'x-request-id',
        'request-id',
        'traceparent',
        'tracestate',
        'baggage',
      ].includes(key)
    ) {
      delete request.headers[key];
    }
  }
  request.headers.connection = 'close';
  const body = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
  if (body) {
    request.headers['content-type'] = 'application/json';
    request.headers['content-length'] = String(body.length);
  }
  request.rawHeaders = Object.entries(request.headers).flatMap(([key, value]) =>
    value === undefined ? [] : [key, Array.isArray(value) ? value.join(', ') : value],
  );
  const response = new ServerResponse(request);
  response.useChunkedEncodingByDefault = false;
  response.shouldKeepAlive = false;
  const result = (): ResponseHttpResult => ({
    status: response.statusCode,
    contentType: String(response.getHeader('content-type') ?? ''),
  });
  socket._write = (chunk: Buffer | string, _encoding, callback) => {
    let data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!started) {
      headers = Buffer.concat([headers, data]);
      const end = headers.indexOf('\r\n\r\n');
      if (end < 0) return callback();
      started = true;
      data = headers.subarray(end + 4);
      headers = Buffer.alloc(0);
    }
    Promise.resolve()
      .then(() => (data.length ? input.onBody(data, result()) : undefined))
      .then(
        () => callback(),
        (error: Error) => callback(error),
      );
  };
  socket._writev = (chunks, callback) => {
    socket._write(
      Buffer.concat(
        chunks.map(({ chunk }) => (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))),
      ),
      'utf8',
      callback,
    );
  };
  const fail = (error: Error) => {
    if (finished) return;
    finished = true;
    reject(error);
    response.destroy();
    request.destroy();
    socket.destroy();
  };
  // ServerResponse producers may ignore write(false); bound the native queue too.
  const write = socket.write.bind(socket);
  socket.write = (
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const size =
      typeof chunk === 'string'
        ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : undefined)
        : chunk.byteLength;
    if (socket.writableLength + size > input.maxBufferedBytes) {
      const error = new Error('Responses HTTP output buffer limit');
      fail(error);
      if (typeof encoding === 'function') encoding(error);
      else callback?.(error);
      return false;
    }
    if (typeof encoding === 'function') return write(chunk, encoding);
    return write(chunk, encoding, callback);
  };
  socket.on('error', fail);
  request.on('error', fail);
  response.on('error', fail);
  response.on('finish', () => {
    if (finished) return;
    finished = true;
    resolve(result());
    socket.destroy();
  });
  response.on('close', () => {
    if (!finished)
      fail(
        new Error(
          `Responses transport closed (ended=${response.writableEnded}, finished=${response.writableFinished})`,
        ),
      );
  });
  response.assignSocket(socket);
  input.initialize?.(request);
  queueMicrotask(() => {
    if (finished) return;
    try {
      input.application(request, response);
      if (body) request.push(body);
      request.push(null);
      request.complete = true;
    } catch (error) {
      fail(error instanceof Error ? error : new Error('Responses dispatch failed'));
    }
  });
  return { done, abort: () => fail(new Error('Responses transport cancelled')) };
}
