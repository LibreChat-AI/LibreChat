import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from './types';
import { SLACK_REQUEST_MAX_BYTES } from './events';

export interface WebhookReply {
  status: number;
  body: object;
}
export interface WebhookHeaders {
  signature?: unknown;
  timestamp?: unknown;
  contentType?: unknown;
}

export interface WebhookHTTPOptions<T> {
  ready: () => boolean;
  match: (path: string) => T | undefined;
  capacity: number;
  maxBodyBytes: number;
  deadlineMs: number;
  signatureHeader: string;
  timestampHeader: string;
  failureEvent: string;
  dispatch: (
    body: Buffer,
    headers: WebhookHeaders,
    route: T,
    signal: AbortSignal,
    path: string,
  ) => Promise<WebhookReply>;
  log: Logger;
}

/** Bounded raw-byte transport; provider adapters own authentication and payload interpretation. */
export class WebhookHTTPServer<T> {
  private active = 0;
  constructor(private readonly options: WebhookHTTPOptions<T>) {
    if (
      ![options.capacity, options.maxBodyBytes, options.deadlineMs].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new TypeError('Invalid webhook policy');
  }

  async http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url?.split('?')[0] || '';
    const send = (status: number, body: object) => {
      if (response.headersSent || response.destroyed) return;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
    };
    if (request.method === 'GET' && path === '/livez') {
      send(200, { status: 'ok' });
      return;
    }
    if (request.method === 'GET' && ['/healthz', '/readyz'].includes(path)) {
      const ready = this.options.ready();
      send(ready ? 200 : 503, { status: ready ? 'ready' : 'not_ready' });
      return;
    }
    const route = this.options.match(path);
    if (request.method !== 'POST' || route === undefined) {
      send(404, { error: 'not_found' });
      return;
    }
    if (this.active >= this.options.capacity) {
      send(503, { error: 'capacity_exhausted' });
      return;
    }
    this.active++;
    const controller = new AbortController();
    const stopReading = () => {
      if (!request.complete) request.destroy();
    };
    const aborted = () => controller.abort();
    controller.signal.addEventListener('abort', stopReading, { once: true });
    request.on('aborted', aborted);
    const timeout = setTimeout(() => {
      send(503, { error: 'delivery_not_accepted' });
      controller.abort();
    }, this.options.deadlineMs);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > this.options.maxBodyBytes) {
          send(413, { error: 'payload_too_large' });
          return;
        }
        chunks.push(bytes);
        controller.signal.throwIfAborted();
      }
      const reply = await this.options.dispatch(
        Buffer.concat(chunks),
        {
          signature: request.headers[this.options.signatureHeader],
          timestamp: request.headers[this.options.timestampHeader],
          contentType: request.headers['content-type'],
        },
        route,
        controller.signal,
        path,
      );
      controller.signal.throwIfAborted();
      send(reply.status, reply.body);
    } catch {
      this.options.log.warn(this.options.failureEvent);
      if (!response.headersSent) send(503, { error: 'delivery_not_accepted' });
    } finally {
      clearTimeout(timeout);
      request.removeListener('aborted', aborted);
      controller.signal.removeEventListener('abort', stopReading);
      this.active--;
    }
  }
}

export class SlackHTTPServer extends WebhookHTTPServer<boolean> {
  constructor(
    options: Pick<WebhookHTTPOptions<boolean>, 'ready' | 'match' | 'capacity' | 'dispatch' | 'log'>,
  ) {
    super({
      ...options,
      maxBodyBytes: SLACK_REQUEST_MAX_BYTES,
      deadlineMs: 2000,
      signatureHeader: 'x-slack-signature',
      timestampHeader: 'x-slack-request-timestamp',
      failureEvent: 'slack_delivery_not_accepted',
    });
  }
}
