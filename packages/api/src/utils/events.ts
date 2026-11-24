import type { Response as ServerResponse } from 'express';
import type { ServerSentEvent } from '~/types';

/** Minimal writable transport; an Express response satisfies it. */
export interface GuardedWriter {
  write(chunk: string): boolean | void;
  writableEnded?: boolean;
  headersSent?: boolean;
  destroyed?: boolean;
}

/**
 * Writes a chunk unless the response has already ended or been destroyed
 * (client disconnect), which would otherwise raise `ERR_STREAM_WRITE_AFTER_END`.
 * @returns whether the chunk was handed to the transport.
 */
export function writeGuarded(res: GuardedWriter, chunk: string): boolean {
  if (res.writableEnded === true || res.destroyed === true) {
    return false;
  }
  res.write(chunk);
  return true;
}

/**
 * Writes a chunk only to a response that is already streaming. One whose headers are
 * unsent is still owed its JSON body, and a write would send the headers first.
 * @returns whether the chunk was handed to the transport.
 */
export function writeStreaming(res: GuardedWriter, chunk: string): boolean {
  if (res.headersSent !== true) {
    return false;
  }
  return writeGuarded(res, chunk);
}

/**
 * Sends a Server-Sent Event to the client.
 * Empty-string StreamEvent data is silently dropped.
 */
export function sendEvent(res: ServerResponse, event: ServerSentEvent): void {
  if ('data' in event && typeof event.data === 'string' && event.data.length === 0) {
    return;
  }
  writeGuarded(res, `event: message\ndata: ${JSON.stringify(event)}\n\n`);
}

/**
 * Sends error data in Server Sent Events format and ends the response.
 * @param res - The server response.
 * @param message - The error message.
 */
export function handleError(res: ServerResponse, message: string): void {
  writeGuarded(res, `event: error\ndata: ${JSON.stringify(message)}\n\n`);
  res.end();
}
