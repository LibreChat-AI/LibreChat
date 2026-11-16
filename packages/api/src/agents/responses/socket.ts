import { z } from 'zod';
import WebSocket, { WebSocketServer } from 'ws';
import { StringDecoder } from 'node:string_decoder';
import { responsesProtocolSchema } from 'librechat-data-provider';
import type { IncomingMessage, RequestListener, Server } from 'node:http';
import type { RequestHandler } from 'express';
import type { Duplex } from 'node:stream';
import type { ServerRequest } from '~/types/http';
import { sendResponsesErrorResponse } from './service';
import { responseSnapshotEvents } from './snapshot';
import { dispatchResponseHttp } from './adapter';
import { responseTenantId } from './scope';

function guardSocketErrors(socket: Duplex): void {
  const onError = () => socket.destroy();
  socket.on('error', onError);
  socket.once('close', () => socket.off('error', onError));
}

export const RESPONSE_SOCKET_PATH = '/api/agents/v1/responses';
type Limits = z.infer<typeof responsesProtocolSchema>['websocket'];
type Identity = { userId: string; tenantId: string; model: string };
type CachedTurn = { id: string; identity: Identity; payload: Buffer };
type TurnContext = {
  kind: 'turn';
  cached?: CachedTurn;
  identity?: Identity;
  request?: ServerRequest;
  replayNames?: string[];
};
type UpgradeContext = { kind: 'upgrade'; accept: (limits: Limits) => void };
const contexts = new WeakMap<IncomingMessage, TurnContext | UpgradeContext>();
const frame = z
  .object({ type: z.literal('response.create'), model: z.string().min(1) })
  .passthrough();
const cachedPayload = z.object({
  input: z.array(z.unknown()),
  toolNames: z.array(z.string()),
});
const functionCall = z.object({ type: z.literal('function_call'), name: z.string() });
const functionTool = z.object({ type: z.literal('function'), name: z.string() });
const terminal = z
  .object({ id: z.string(), status: z.string(), output: z.array(z.unknown()) })
  .passthrough();
function items(value: unknown): unknown[] {
  if (typeof value === 'string') return [{ type: 'message', role: 'user', content: value }];
  return Array.isArray(value) ? value : [];
}

/** Mounted after the ordinary remote auth/config/feature gates, on both transports. */
export const admitResponseSocket: RequestHandler = (req, res, next) => {
  const context = contexts.get(req);
  if (!context) return next();
  const config = responsesProtocolSchema.parse(
    (req as ServerRequest).config?.endpoints?.agents?.responses ?? {},
  ).websocket;
  if (!config.enabled)
    return void sendResponsesErrorResponse(
      res,
      404,
      'Responses WebSocket transport is disabled.',
      'not_found',
      'websocket_unavailable',
    );
  if (context.kind === 'upgrade') {
    context.accept(config);
    res.status(204).end();
    return;
  }
  const request = req as ServerRequest;
  context.identity = {
    userId: String(request.user?.id ?? ''),
    tenantId: responseTenantId(request.user?.tenantId) ?? '',
    model: req.body.model,
  };
  if (Buffer.byteLength(JSON.stringify(req.body)) > config.maxMessageBytes)
    return void sendResponsesErrorResponse(
      res,
      413,
      'Request exceeds the configured limit.',
      'invalid_request',
      'request_too_large',
    );
  const previous = req.body.previous_response_id;
  if (previous != null && context.cached && context.cached.id === previous) {
    const identity = context.cached.identity;
    if (
      Object.keys(identity).some(
        (key) => Reflect.get(identity, key) !== Reflect.get(context.identity!, key),
      )
    )
      return void sendResponsesErrorResponse(
        res,
        400,
        'Previous response is unavailable.',
        'invalid_request',
        'previous_response_not_found',
      );
    const restored = cachedPayload.parse(JSON.parse(context.cached.payload.toString('utf8')));
    context.replayNames = restored.toolNames;
    const { previous_response_id: _previous, ...body } = req.body;
    req.body = {
      ...body,
      input: [...restored.input, ...items(body.input)],
    };
  } else if (previous != null && req.body.store !== true) {
    return void sendResponsesErrorResponse(
      res,
      400,
      'Previous response is unavailable.',
      'invalid_request',
      'previous_response_not_found',
    );
  }

  if (Buffer.byteLength(JSON.stringify(req.body)) > config.maxCacheBytes)
    return void sendResponsesErrorResponse(
      res,
      413,
      'Response input exceeds the configured limit.',
      'invalid_request',
      'request_too_large',
    );
  context.request = request;
  next();
};

/** Replay allowlist only; historical caller tools never become server executors. */
export function responseSocketToolNames(req: IncomingMessage): ReadonlySet<string> {
  const context = contexts.get(req);
  return new Set(context?.kind === 'turn' ? context.replayNames : []);
}

/** Only a server-marked upgrade can reach the handshake; a normal GET is not one. */
export const acceptResponseSocket: RequestHandler = (_req, res) => {
  sendResponsesErrorResponse(res, 405, 'Use POST to create a response.', 'invalid_request');
};

/**
 * Native upgrade plus an in-process HTTP adapter: every turn traverses the same
 * Express routes and fresh authentication as a POST. The conversation cache contains
 * bounded owner/tenant/model-bound store:false history; credential headers remain
 * in the connection transport and are freshly authenticated on every turn.
 */
export function installResponseSockets(deps: {
  server: Server;
  application: RequestListener;
  limits?: Partial<Limits>;
  path?: string;
  onError?: (error: unknown) => void;
}): () => Promise<void> {
  const limits = responsesProtocolSchema.shape.websocket.parse(deps.limits ?? {});
  const path = deps.path ?? RESPONSE_SOCKET_PATH;
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: limits.maxMessageBytes,
    perMessageDeflate: false,
  });
  let stopping = false;
  const upgradeSockets = new Set<Duplex>();
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (req.url?.split('?')[0] !== path) {
      if (deps.server.listenerCount('upgrade') === 1) {
        guardSocketErrors(socket);
        socket.destroy();
      }
      return;
    }
    guardSocketErrors(socket);
    // Overload must not allocate another pending/rejecting connection.
    if (stopping || sockets.clients.size + upgradeSockets.size >= limits.maxConnections) {
      socket.destroy();
      return;
    }
    upgradeSockets.add(socket);
    let active = true;
    let abortProbe: (() => void) | undefined;
    const timer = setTimeout(() => {
      active = false;
      abortProbe?.();
      socket.destroy();
    }, limits.admissionTimeoutMs);
    timer.unref();
    const onClose = () => {
      active = false;
      abortProbe?.();
      upgradeSockets.delete(socket);
      clearTimeout(timer);
    };
    socket.once('close', onClose);
    const reject = (status: number) => {
      if (socket.destroyed) return;
      // A half-open peer must not retain the readable side after rejection.
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        () => socket.destroy(),
      );
    };
    if (!req.headers.authorization) {
      reject(401);
      return;
    }
    let accepted = false;
    const admittedLimits = { ...limits };
    const probe = dispatchResponseHttp({
      application: deps.application,
      maxBufferedBytes: limits.maxBufferedBytes,
      source: req,
      method: 'GET',
      path,
      initialize: (request) =>
        contexts.set(request, {
          kind: 'upgrade',
          accept: (tenantLimits) => {
            accepted = true;
            for (const key of [
              'maxMessageBytes',
              'maxQueuedTurns',
              'maxCacheBytes',
              'maxBufferedBytes',
              'maxConnectionMs',
              'heartbeatMs',
            ] as const) {
              admittedLimits[key] = Math.min(limits[key], tenantLimits[key]);
            }
          },
        }),
      onBody: () => {},
    });
    abortProbe = probe.abort;
    void probe.done
      .then((result) => {
        if (!active || socket.destroyed) return;
        if (!accepted || result.status !== 204) {
          reject(result.status);
          return;
        }
        sockets.handleUpgrade(req, socket, head, (ws) => {
          // Transfer ownership only after ws has accepted the socket.
          clearTimeout(timer);
          upgradeSockets.delete(socket);
          socket.off('close', onClose);
          abortProbe = undefined;
          serve(ws, req, admittedLimits);
        });
      })
      .catch((error) => {
        if (active) {
          deps.onError?.(error);
          socket.destroy();
        }
      });
  };
  function serve(ws: WebSocket, source: IncomingMessage, limits: Limits) {
    let cached: CachedTurn | undefined;
    let running = false;
    let closed = false;
    let abort: (() => void) | undefined;
    const queue: { data: Buffer; binary: boolean }[] = [];
    const send = (data: unknown) =>
      new Promise<void>((resolve, reject) => {
        if (closed || ws.readyState !== WebSocket.OPEN)
          return reject(new Error('Responses socket closed'));
        const text = JSON.stringify(data);
        if (ws.bufferedAmount + Buffer.byteLength(text) > limits.maxBufferedBytes) {
          ws.terminate();
          return reject(new Error('Responses socket backpressure limit'));
        }
        ws.send(text, (error) => (error ? reject(error) : resolve()));
      });
    const error = (status: number, code: string, message: string) =>
      send({
        type: 'error',
        status,
        error: { type: 'invalid_request_error', code, message, param: null },
      });
    const dispose = () => {
      closed = true;
      cached = undefined;
      queue.length = 0;
      abort?.();
      clearTimeout(lifetime);
      clearInterval(heartbeat);
    };
    const lifetime = setTimeout(() => {
      // Notification is best-effort; cancellation never waits for a blocked writer.
      void error(
        400,
        'websocket_connection_limit_reached',
        'Open a new Responses connection.',
      ).catch(() => {});
      dispose();
      ws.close(1000);
      if (ws.bufferedAmount > 0) ws.terminate();
    }, limits.maxConnectionMs);
    lifetime.unref();
    let alive = true;
    const heartbeat = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) {
        dispose();
        return;
      }
      if (!alive) {
        ws.terminate();
        return;
      }
      alive = false;
      ws.ping();
    }, limits.heartbeatMs);
    heartbeat.unref();
    ws.on('pong', () => {
      alive = true;
    });
    ws.on('close', dispose);
    ws.on('error', dispose);
    const process = async () => {
      if (running || closed) return;
      running = true;
      try {
        while (queue.length && !closed) {
          const raw = queue.shift()!;
          let body: Record<string, unknown>;
          try {
            if (raw.binary) throw new Error('binary');
            const value = frame.parse(JSON.parse(raw.data.toString('utf8')));
            if (['stream', 'stream_options', 'background'].some((key) => key in value))
              throw new Error('http fields');
            const { type: _type, ...parsed } = value;
            body = parsed;
          } catch {
            cached = undefined;
            await error(
              400,
              'invalid_request',
              'Send a valid response.create event without HTTP transport fields.',
            );
            continue;
          }
          const previous = body.previous_response_id;
          const context: TurnContext = { kind: 'turn', cached };
          let completed: z.infer<typeof terminal> | undefined;
          let pending = '';
          let failure = '';
          let terminalSent = false;
          const decoder = new StringDecoder('utf8');
          const forward = async (data: unknown) => {
            if (data && typeof data === 'object' && 'response' in data) {
              const response = terminal.safeParse(data.response);
              if (response.success) {
                if (previous != null) response.data.previous_response_id = previous;
                Reflect.set(data, 'response', response.data);
                if (
                  'type' in data &&
                  ['response.completed', 'response.failed', 'response.incomplete'].includes(
                    String(data.type),
                  )
                ) {
                  terminalSent = true;
                  if (data.type === 'response.completed') completed = response.data;
                }
              }
            }
            await send(data);
          };
          const call = dispatchResponseHttp({
            application: deps.application,
            maxBufferedBytes: limits.maxBufferedBytes,
            source,
            method: 'POST',
            path,
            body: { ...body, stream: true },
            initialize: (req) => contexts.set(req, context),
            onBody: async (chunk, result) => {
              if (!result.contentType.includes('text/event-stream')) {
                failure += decoder.write(chunk);
                if (Buffer.byteLength(failure) > limits.maxBufferedBytes)
                  throw new Error('Responses error frame too large');
                return;
              }
              pending += decoder.write(chunk);
              if (Buffer.byteLength(pending) > limits.maxBufferedBytes)
                throw new Error('Responses event too large');
              let boundary: number;
              while ((boundary = pending.indexOf('\n\n')) >= 0) {
                const event = pending.slice(0, boundary);
                pending = pending.slice(boundary + 2);
                const text = event
                  .split('\n')
                  .filter((line) => line.startsWith('data:'))
                  .map((line) => line.slice(5).trimStart())
                  .join('\n');
                if (!text || text === '[DONE]') continue;
                await forward(JSON.parse(text));
              }
            },
          });
          abort = call.abort;
          try {
            const result = await call.done;
            failure += decoder.end();
            if (result.status < 400) {
              if (result.contentType.includes('application/json')) {
                for (const event of responseSnapshotEvents(JSON.parse(failure)))
                  await forward(event);
              }
              if (!terminalSent)
                throw new Error('Responses delivery ended without a terminal event');
            }
            if (result.status >= 400) {
              let code = 'response_failed';
              let message = 'Response request failed.';
              try {
                const value = z
                  .object({ error: z.object({ code: z.string().nullish(), message: z.string() }) })
                  .parse(JSON.parse(failure));
                code = value.error.code ?? code;
                message = value.error.message;
              } catch {
                // Non-JSON HTTP failures use the safe transport fallback.
              }
              const missingPrevious =
                previous != null &&
                result.status === 404 &&
                ['response_failed', 'response_not_found'].includes(code);
              await error(
                missingPrevious ? 400 : result.status,
                missingPrevious ? 'previous_response_not_found' : code,
                missingPrevious ? 'Previous response is unavailable.' : message,
              );
              if (previous != null) cached = undefined;
            } else if (
              completed?.status === 'completed' &&
              body.store !== true &&
              context.identity &&
              context.request
            ) {
              const input = [
                ...items(Reflect.get(context.request.body, 'input')),
                ...completed.output,
              ];
              const allowed = new Set([
                ...(context.replayNames ?? []),
                ...items(completed.tools).flatMap((tool) => {
                  const parsed = functionTool.safeParse(tool);
                  return parsed.success ? [parsed.data.name] : [];
                }),
              ]);
              // Count history and replay metadata together; retain no parsed object graph.
              const toolNames = [
                ...new Set(
                  input.flatMap((item) => {
                    const call = functionCall.safeParse(item);
                    return call.success && allowed.has(call.data.name) ? [call.data.name] : [];
                  }),
                ),
              ];
              const payload = Buffer.from(JSON.stringify({ input, toolNames }));
              cached =
                payload.length <= limits.maxCacheBytes
                  ? { id: completed.id, identity: context.identity, payload }
                  : undefined;
            } else {
              cached = undefined;
            }
          } catch (cause) {
            cached = undefined;
            if (!closed) {
              deps.onError?.(cause);
              await error(503, 'response_unavailable', 'Response transport is unavailable.');
            }
          } finally {
            abort = undefined;
          }
        }
      } finally {
        running = false;
      }
    };
    ws.on('message', (raw, binary) => {
      if (closed) return;
      const size = Array.isArray(raw)
        ? raw.reduce((sum, chunk) => sum + chunk.length, 0)
        : raw.byteLength;
      if (size > limits.maxMessageBytes) {
        dispose();
        ws.close(1009, 'Response payload exceeds the configured limit.');
        return;
      }
      if (queue.length + (running ? 1 : 0) >= limits.maxQueuedTurns) {
        // An uncorrelated error must not interrupt another turn's event stream.
        dispose();
        ws.close(1008, 'Too many queued response turns.');
        return;
      }
      let data: Buffer;
      if (Buffer.isBuffer(raw)) data = Buffer.from(raw);
      else if (Array.isArray(raw)) data = Buffer.concat(raw);
      else data = Buffer.from(raw);
      queue.push({ data, binary });
      void process().catch((cause) => {
        deps.onError?.(cause);
        ws.terminate();
      });
    });
  }
  deps.server.on('upgrade', upgrade);
  return async () => {
    stopping = true;
    deps.server.removeListener('upgrade', upgrade);
    for (const socket of upgradeSockets) socket.destroy();
    upgradeSockets.clear();
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  };
}
