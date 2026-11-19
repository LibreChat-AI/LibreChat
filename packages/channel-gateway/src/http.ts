import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from './types';
import { SLACK_REQUEST_MAX_BYTES } from './events';

export interface WebhookReply<O extends string = string> {
  status: number;
  body: object;
  /** Names how the request ended, for an observer. Providers without one omit it. */
  outcome?: O;
}
/** Outcomes the transport decides by itself, before or instead of a provider reply. */
export type WebhookTransportOutcome =
  | 'not_found'
  | 'at_capacity'
  | 'too_large'
  | 'deadline'
  | 'unavailable';
export interface WebhookObservation<O extends string = string> {
  outcome: O | WebhookTransportOutcome;
  /** Milliseconds from route match to the single response write, when one was written. */
  ackMs?: number;
}
export interface WebhookHeaders {
  signature?: unknown;
  timestamp?: unknown;
  contentType?: unknown;
}

export interface WebhookHTTPOptions<T, O extends string = string> {
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
  ) => Promise<WebhookReply<O>>;
  /** Called once per request that reached the router. It never changes a response. */
  observe?: (observation: WebhookObservation<O>) => void;
  log: Logger;
}

/** Bounded raw-byte transport; provider adapters own authentication and payload interpretation. */
export class WebhookHTTPServer<T, O extends string = string> {
  private active = 0;
  constructor(private readonly options: WebhookHTTPOptions<T, O>) {
    if (
      ![options.capacity, options.maxBodyBytes, options.deadlineMs].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    )
      throw new TypeError('Invalid webhook policy');
  }

  async http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url?.split('?')[0] || '';
    const send = (status: number, body: object): boolean => {
      if (response.headersSent || response.destroyed) return false;
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(body));
      return true;
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
      this.observe({ outcome: 'not_found' });
      return;
    }
    const startedAt = performance.now();
    let observed = false;
    // The first decision names the request, so a response after the deadline cannot count twice.
    const respond = (
      status: number,
      body: object,
      outcome: O | WebhookTransportOutcome | undefined,
    ) => {
      const written = send(status, body);
      if (observed || outcome === undefined) return;
      observed = true;
      this.observe({ outcome, ...(written ? { ackMs: performance.now() - startedAt } : {}) });
    };
    if (this.active >= this.options.capacity) {
      respond(503, { error: 'capacity_exhausted' }, 'at_capacity');
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
      respond(503, { error: 'delivery_not_accepted' }, 'deadline');
      controller.abort();
    }, this.options.deadlineMs);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > this.options.maxBodyBytes) {
          respond(413, { error: 'payload_too_large' }, 'too_large');
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
      respond(reply.status, reply.body, reply.outcome);
    } catch {
      this.options.log.warn(this.options.failureEvent);
      respond(503, { error: 'delivery_not_accepted' }, 'unavailable');
    } finally {
      clearTimeout(timeout);
      request.removeListener('aborted', aborted);
      controller.signal.removeEventListener('abort', stopReading);
      this.active--;
    }
  }

  /** Telemetry must never change a response, so a throwing observer is ignored. */
  private observe(observation: WebhookObservation<O>): void {
    try {
      this.options.observe?.(observation);
    } catch {
      // The request outcome is already decided.
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
