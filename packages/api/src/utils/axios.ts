import axios from 'axios';
import { Buffer } from 'buffer';
import { logger } from '@librechat/data-schemas';
import type { AxiosInstance, AxiosProxyConfig, AxiosError } from 'axios';

/**
 * Render `error.response.data` as a small, log-safe value. Axios surfaces
 * the response body in whichever native shape the request asked for, so
 * `responseType: 'arraybuffer'` yields a `Buffer` (raw bytes — JSON-
 * serializes as `{type: 'Buffer', data: [123, 34, ...]}`, ~4 chars per
 * byte) and `responseType: 'stream'` yields a `Readable` (whose internal
 * state JSON-serializes the full readableState ring buffer + socket
 * fields, easily megabytes per error). Both are useless for diagnostics
 * and drown the log line. Decode small buffers as UTF-8 (truncated) and
 * stub streams entirely.
 */
const renderResponseData = (data: unknown): unknown => {
  if (data == null) return data;
  if (Buffer.isBuffer(data)) {
    const MAX = 2048;
    const text = data.subarray(0, MAX).toString('utf8');
    return data.length > MAX ? `${text}…[+${data.length - MAX} bytes]` : text;
  }
  // Readable streams (responseType: 'stream') and other piped sources.
  if (
    typeof data === 'object' &&
    data !== null &&
    typeof (data as { pipe?: unknown }).pipe === 'function'
  ) {
    return '[stream]';
  }
  return data;
};

/**
 * Logs Axios errors based on the error object and a custom message.
 * @param options - The options object.
 * @param options.message - The custom message to be logged.
 * @param options.error - The Axios error object.
 * @returns The log message.
 */
export const logAxiosError = ({
  message,
  error,
}: {
  message: string;
  error: AxiosError | Error | unknown;
}): string => {
  let logMessage = message;
  try {
    const stack =
      error != null
        ? (error as Error | AxiosError)?.stack || 'No stack trace available'
        : 'No stack trace available';
    const errorMessage =
      error != null
        ? (error as Error | AxiosError)?.message || 'No error message available'
        : 'No error message available';

    if (axios.isAxiosError(error) && error.response && error.response?.status) {
      const { status, headers, data } = error.response;
      logMessage = `${message} The server responded with status ${status}: ${error.message}`;
      logger.error(logMessage, {
        status,
        headers,
        data: renderResponseData(data),
        stack,
      });
    } else if (axios.isAxiosError(error) && error.request) {
      const { method, url } = error.config || {};
      logMessage = `${message} No response received for ${method ? method.toUpperCase() : ''} ${url || ''}: ${error.message}`;
      logger.error(logMessage, {
        requestInfo: { method, url },
        stack,
      });
    } else if (errorMessage?.includes("Cannot read properties of undefined (reading 'status')")) {
      logMessage = `${message} It appears the request timed out or was unsuccessful: ${errorMessage}`;
      logger.error(logMessage, { stack });
    } else {
      logMessage = `${message} An error occurred while setting up the request: ${errorMessage}`;
      logger.error(logMessage, { stack });
    }
  } catch (err: unknown) {
    logMessage = `Error in logAxiosError: ${(err as Error).message}`;
    logger.error(logMessage, { stack: (err as Error).stack || 'No stack trace available' });
  }
  return logMessage;
};

/** Adds upload context without discarding the Axios response metadata used by
 * Code API recovery. Transport-specific branching remains in this typed module. */
export function wrapCodeApiUploadError(error: unknown, message: string): Error {
  const wrapped = new Error(logAxiosError({ message, error }), { cause: error });
  if (axios.isAxiosError(error)) {
    Object.assign(wrapped, {
      isAxiosError: true,
      response: error.response,
    });
  }
  return wrapped;
}

/**
 * Creates and configures an Axios instance with optional proxy settings.

 * @returns A configured Axios instance
 * @throws If there's an issue creating the Axios instance or parsing the proxy URL
 */
export function createAxiosInstance(): AxiosInstance {
  const instance = axios.create();

  if (process.env.proxy) {
    try {
      const url = new URL(process.env.proxy);

      const proxyConfig: Partial<AxiosProxyConfig> = {
        host: url.hostname.replace(/^\[|\]$/g, ''),
        protocol: url.protocol.replace(':', ''),
      };

      if (url.port) {
        proxyConfig.port = parseInt(url.port, 10);
      }

      instance.defaults.proxy = proxyConfig as AxiosProxyConfig;
    } catch (error) {
      console.error('Error parsing proxy URL:', error);
      throw new Error(`Invalid proxy URL: ${process.env.proxy}`);
    }
  }

  return instance;
}
