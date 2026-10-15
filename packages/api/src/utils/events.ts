import type { Response as ServerResponse } from 'express';
import type { ServerSentEvent } from '~/types';
import { omitProviderItemsFromEvent } from './message';

/**
 * Sends a Server-Sent Event to the client.
 * Empty-string StreamEvent data is silently dropped.
 */
export function sendEvent(res: ServerResponse, event: ServerSentEvent): void {
  if ('data' in event && typeof event.data === 'string' && event.data.length === 0) {
    return;
  }
  res.write(`event: message\ndata: ${JSON.stringify(omitProviderItemsFromEvent(event))}\n\n`);
}

/**
 * Sends error data in Server Sent Events format and ends the response.
 * @param res - The server response.
 * @param message - The error message.
 */
export function handleError(res: ServerResponse, message: string): void {
  res.write(`event: error\ndata: ${JSON.stringify(message)}\n\n`);
  res.end();
}
