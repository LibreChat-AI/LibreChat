import { DEFAULT_MCP_APP_OPERATION_LIMITS } from 'librechat-data-provider';
import type { TMCPAppOperationLimits } from 'librechat-data-provider';

/** Runtime consumers take a validated deployment snapshot rather than reading process state. */
export const getMCPAppOperationLimits = (limits?: TMCPAppOperationLimits): TMCPAppOperationLimits =>
  limits ?? DEFAULT_MCP_APP_OPERATION_LIMITS;

export class MCPAppBudgetError extends Error {
  constructor(
    public readonly status: 413 | 502 | 503 | 504,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'MCPAppBudgetError';
  }
}

/** Count admitted operations, not just HTTP responses: aborted work holds its slot until it settles. */
export class MCPAppOperationBudget {
  private active = 0;

  async run<T>(
    callerSignal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
    limits: TMCPAppOperationLimits = DEFAULT_MCP_APP_OPERATION_LIMITS,
  ): Promise<T> {
    const { timeoutMs, maxActive } = limits;
    callerSignal.throwIfAborted();
    if (this.active >= maxActive) {
      throw new MCPAppBudgetError(
        503,
        'mcp_app_capacity',
        'MCP App capacity is temporarily exhausted',
      );
    }
    this.active++;
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([callerSignal, timeout]);
    const work = Promise.resolve().then(() => operation(signal));
    // Work may ignore abort. Keep its slot occupied, and observe a later rejection, even after the
    // HTTP request has been answered. Never release a slot while an MCP operation can still run.
    void work.then(
      () => {
        this.active--;
      },
      () => {
        this.active--;
      },
    );
    let onAbort: (() => void) | undefined;
    const interrupted = new Promise<never>((_resolve, reject) => {
      onAbort = () =>
        reject(
          timeout.aborted
            ? new MCPAppBudgetError(504, 'mcp_app_timeout', 'MCP App operation timed out')
            : (callerSignal.reason ?? new Error('MCP App request cancelled')),
        );
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    try {
      const result = await Promise.race([work, interrupted]);
      if (signal.aborted) {
        if (timeout.aborted) {
          throw new MCPAppBudgetError(504, 'mcp_app_timeout', 'MCP App operation timed out');
        }
        callerSignal.throwIfAborted();
      }
      return result;
    } finally {
      signal.removeEventListener('abort', onAbort!);
    }
  }
}

/** JSON must be measured in the same UTF-8 form Express sends to the App bridge. */
export function assertMCPAppResultFits(
  result: unknown,
  limits: TMCPAppOperationLimits = DEFAULT_MCP_APP_OPERATION_LIMITS,
): void {
  const { maxBytes } = limits;
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(result);
  } catch {
    throw new MCPAppBudgetError(
      502,
      'mcp_app_invalid_response',
      'MCP App response cannot be serialized',
    );
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new MCPAppBudgetError(502, 'mcp_app_response_too_large', 'MCP App response is too large');
  }
}

/** Stateful across chunks and CRLF boundaries, resetting only at a blank SSE event separator. */
export function createMCPAppSSEEventGuard(maxEventBytes: number): (chunk: Uint8Array) => boolean {
  let eventBytes = 0;
  let lineBytes = 0;
  let previousCR = false;
  return (chunk) => {
    for (const byte of chunk) {
      if (byte === 10 && previousCR) {
        previousCR = false;
        continue;
      }
      if (byte === 10 || byte === 13) {
        previousCR = byte === 13;
        if (lineBytes === 0) eventBytes = 0;
        else eventBytes++;
        lineBytes = 0;
      } else {
        previousCR = false;
        eventBytes++;
        lineBytes++;
      }
      if (eventBytes > maxEventBytes) return false;
    }
    return true;
  };
}

/** GET SSE streams are long-lived: limit each complete event before EventSource calls JSON.parse. */
export function guardMCPAppSSEEvents(
  response: Response,
  maxEventBytes: number,
  onOversize?: (error: MCPAppBudgetError) => void,
): Response {
  if (
    !response.body ||
    !response.ok ||
    response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !==
      'text/event-stream'
  ) {
    return response;
  }
  const fitsEvent = createMCPAppSSEEventGuard(maxEventBytes);
  const guarded = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        if (!fitsEvent(chunk)) {
          const error = new MCPAppBudgetError(
            502,
            'mcp_app_event_too_large',
            'MCP App event is too large',
          );
          onOversize?.(error);
          throw error;
        }
        controller.enqueue(chunk);
      },
    }),
  );
  return new Response(guarded, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}
