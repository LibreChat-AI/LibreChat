import type { Request, Response } from 'express';
import { getContentFilterError } from '~/middleware/contentFilter';
import { isEnabled } from '~/utils';

const HEARTBEAT_INTERVAL_MS = 1000;
const EVENT_STREAM_MEDIA_TYPE = 'text/event-stream';

const SSE_HEADERS = {
  'Content-Type': EVENT_STREAM_MEDIA_TYPE,
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  /** Required so Nginx/other proxies don't buffer the stream. */
  'X-Accel-Buffering': 'no',
};

function writeSseEvent<T>(res: Response, event: string, data: T): void {
  if (res.writableEnded || res.destroyed) {
    return;
  }
  res.write(`event:${event}\nid:${Date.now()}\ndata:${JSON.stringify(data)}\n\n`);
}

export function shouldUseUploadSse(req: Request): boolean {
  if (!isEnabled(process.env.FILE_UPLOAD_SSE_ENABLED)) {
    return false;
  }

  return (
    req.headers.accept?.split(',').some((value) => {
      const [mediaType] = value.split(';', 1);
      return mediaType.trim().toLowerCase() === EVENT_STREAM_MEDIA_TYPE;
    }) ?? false
  );
}

export interface UploadSseStream {
  /** Emits the successful upload payload as an `event:data` message. */
  sendData: <T>(data: T) => void;
  /** Emits a failure payload as an `event:error` message. */
  sendError: <T>(data: T) => void;
  /** Emits the terminal `event:close` message, stops the heartbeat, and ends the response. */
  close: () => void;
}

export interface UploadPolicyErrorContext {
  readonly tempFileId?: string | null;
  readonly toolResource?: string | null;
}

export function sendUploadPolicyError(
  res: Response,
  sseStream: UploadSseStream | null | undefined,
  error: unknown,
  context: UploadPolicyErrorContext = {},
): boolean {
  const policyError = getContentFilterError(error);
  if (policyError == null) {
    return false;
  }
  if (sseStream) {
    sseStream.sendError({
      ...policyError.body,
      code: policyError.statusCode,
      temp_file_id: context.tempFileId,
      tool_resource: context.toolResource,
      display_to_user: true,
    });
    return true;
  }
  res.status(policyError.statusCode).json(policyError.body);
  return true;
}

/**
 * Opens a keep-alive SSE stream for a file-upload response: sends the SSE headers, starts a
 * heartbeat interval so proxies/clients don't time out the connection during long-running
 * uploads, and stops the heartbeat when the client disconnects early.
 *
 * Callers must only invoke this once all synchronous validation and permission checks that
 * might still need to send a normal (non-SSE) response have already passed — once the headers
 * are flushed here, the HTTP status is committed to 200 and can no longer be changed.
 */
export function startUploadSseStream(res: Response): UploadSseStream {
  res.writeHead(200, SSE_HEADERS);
  res.flushHeaders();

  let counter = 1;
  const intervalId = setInterval(() => {
    if (res.writableEnded || res.destroyed) {
      clearInterval(intervalId);
      return;
    }
    writeSseEvent(res, 'heartbeat', { keepAlive: counter++ });
  }, HEARTBEAT_INTERVAL_MS);

  const stopHeartbeat = () => {
    clearInterval(intervalId);
  };
  res.once('close', stopHeartbeat);

  return {
    sendData: (data) => writeSseEvent(res, 'data', data),
    sendError: (data) => writeSseEvent(res, 'error', data),
    close: () => {
      clearInterval(intervalId);
      res.off('close', stopHeartbeat);
      if (!res.writableEnded && !res.destroyed) {
        writeSseEvent(res, 'close', { closedAt: new Date().toISOString() });
        res.end();
      }
    },
  };
}

/**
 * Sends a successful upload response, either as an SSE `event:data` message (when an upload
 * stream is active) or as a plain JSON response.
 */
export function sendUploadSuccess<T extends object>(
  res: Response,
  sseStream: UploadSseStream | null | undefined,
  message: string,
  result: T,
): void {
  if (sseStream) {
    sseStream.sendData({ message, ...result });
    return;
  }
  res.status(200).json({ message, ...result });
}
