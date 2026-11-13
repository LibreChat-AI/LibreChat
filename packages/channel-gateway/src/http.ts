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

/** One bounded reader and acknowledgement deadline for bound and shared Slack ingress. */
export class SlackHTTPServer {
  private active = 0;
  constructor(
    private readonly options: {
      ready: () => boolean;
      match: (path: string) => boolean | undefined;
      capacity: number;
      dispatch: (
        body: Buffer,
        headers: WebhookHeaders,
        interactive: boolean,
        signal: AbortSignal,
        path: string,
      ) => Promise<WebhookReply>;
      log: Logger;
    },
  ) {}

  async http(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = request.url?.split('?')[0] || '';
    const send = (status: number, body: object) => {
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
    const interactive = this.options.match(path);
    if (request.method !== 'POST' || interactive === undefined) {
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
    const timeout = setTimeout(aborted, 2000);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += bytes.length;
        if (size > SLACK_REQUEST_MAX_BYTES) {
          send(413, { error: 'payload_too_large' });
          return;
        }
        chunks.push(bytes);
        controller.signal.throwIfAborted();
      }
      const reply = await this.options.dispatch(
        Buffer.concat(chunks),
        {
          signature: request.headers['x-slack-signature'],
          timestamp: request.headers['x-slack-request-timestamp'],
          contentType: request.headers['content-type'],
        },
        interactive,
        controller.signal,
        path,
      );
      controller.signal.throwIfAborted();
      send(reply.status, reply.body);
    } catch {
      this.options.log.warn('slack_delivery_not_accepted');
      if (!response.headersSent) send(503, { error: 'delivery_not_accepted' });
    } finally {
      clearTimeout(timeout);
      request.removeListener('aborted', aborted);
      controller.signal.removeEventListener('abort', stopReading);
      this.active--;
    }
  }
}
