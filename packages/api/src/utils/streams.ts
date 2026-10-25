import { pipeline } from 'node:stream';
import type { Readable, Writable } from 'node:stream';

/** The client went away mid-response: a cancellation, not an upstream failure. */
export class ClientDisconnectedError extends Error {
  name = 'AbortError';

  constructor() {
    super('Client disconnected');
  }
}

export function isClientDisconnect(error: unknown): error is ClientDisconnectedError {
  return error instanceof ClientDisconnectedError;
}

/**
 * Streams `source` into `res` and ends it. An upstream failure tears the response down instead
 * of surfacing as an uncaught stream error, and a client disconnect destroys the upstream
 * without reaching `onError`, since nothing failed.
 */
export function pipeToResponse(
  source: Readable,
  res: Writable,
  onError?: (error: Error) => void,
): void {
  /** A client can leave while the upstream is still being fetched; `pipeline` would throw. */
  if (res.destroyed) {
    source.destroy();
    return;
  }
  let clientLeft = false;
  let sourceEnded = false;
  source.once('end', () => {
    sourceEnded = true;
  });
  /**
   * Registered before `pipeline`, so it runs before the upstream is torn down in response. A
   * source that already ended may be destroyed while the response flushes; only one that broke
   * off makes the close an upstream failure.
   */
  res.once('close', () => {
    clientLeft = !res.writableFinished && (sourceEnded || !source.destroyed);
  });
  pipeline(source, res, (error) => {
    if (error && !clientLeft) {
      onError?.(error);
    }
  });
}

const guardedResponses = new WeakSet<Writable>();

/**
 * A response that outlives one segment can still fail a buffered write after that segment's
 * listeners are gone. A lasting listener keeps that from becoming an uncaught error; the
 * failure still destroys the response, which the next segment sees as a closed client.
 */
function guardResponse(res: Writable): void {
  if (guardedResponses.has(res)) {
    return;
  }
  guardedResponses.add(res);
  res.on('error', () => undefined);
}

/**
 * Writes one `source` segment into `res`, ending `res` only when `end` is set. Resolves when the
 * segment ends; rejects, destroying `source`, when it fails or the client disconnects first.
 */
export function pipeSegment(
  source: Readable,
  res: Writable,
  { end }: { end: boolean },
): Promise<void> {
  guardResponse(res);
  return new Promise((resolve, reject) => {
    /** A client that left while the previous segment was being fetched already emitted close. */
    if (res.destroyed || res.writableEnded) {
      source.destroy();
      reject(new ClientDisconnectedError());
      return;
    }
    const cleanup = (): void => {
      source.off('end', onEnd);
      source.off('error', onError);
      res.off('close', onClose);
      res.off('error', onError);
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    /** Either side failing ends both: a half-written response would otherwise hang the client. */
    const onError = (error: Error): void => {
      cleanup();
      source.destroy();
      /** Before any audio went out the caller can still answer with an HTTP error. */
      if (!('headersSent' in res) || res.headersSent) {
        res.destroy();
      }
      reject(error);
    };
    const onClose = (): void => {
      cleanup();
      source.destroy();
      reject(new ClientDisconnectedError());
    };
    source.on('end', onEnd);
    source.on('error', onError);
    res.on('error', onError);
    res.on('close', onClose);
    source.pipe(res, { end });
  });
}
