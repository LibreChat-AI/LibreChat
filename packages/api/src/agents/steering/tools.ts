import type {
  ToolExecuteBatchRequest,
  ToolExecuteResult,
  StreamPreemption,
  EventHandler,
} from '@librechat/agents';

const INTERRUPTED =
  'Interrupted by a user message. Cancellation was requested; external effects may already have occurred. Do not repeat this operation automatically.';

export class SteerToolInterrupt extends Error {
  constructor() {
    super('Interrupted by a user message');
    this.name = 'AbortError';
  }
}

export function interruptedToolResult(toolCallId: string): ToolExecuteResult {
  return { toolCallId, status: 'error', content: '', errorMessage: INTERRUPTED };
}

/** Cancel the batch, not the run: its PostToolBatch hook still injects the steer. */
export function interruptToolHandler(
  handler: EventHandler,
  preemption: StreamPreemption,
): EventHandler {
  return {
    handle: async (event: string, data: ToolExecuteBatchRequest, metadata, graph) => {
      if (data.executionContext != null || preemption.subscribe == null) {
        return handler.handle(event, data, metadata, graph);
      }
      const controller = new AbortController();
      const signal =
        data.signal == null ? controller.signal : AbortSignal.any([data.signal, controller.signal]);
      const completed = new Map<string, ToolExecuteResult>();
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      let onAbort: (() => void) | undefined;
      await new Promise<void>((resolve, reject) => {
        const finish = (results: ToolExecuteResult[]) => {
          if (settled) return;
          settled = true;
          try {
            data.resolve(results);
            resolve();
          } catch (error) {
            reject(error);
          }
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          data.reject(error);
          reject(error);
        };
        const interrupt = () => {
          if (settled || data.signal?.aborted || !preemption.shouldPreempt()) return;
          // Claim settlement before abort listeners can publish a competing result.
          const results = data.toolCalls.map(
            (call) => completed.get(call.id) ?? interruptedToolResult(call.id),
          );
          finish(results);
          controller.abort(new SteerToolInterrupt());
        };
        onAbort = () =>
          fail(
            data.signal?.reason instanceof Error
              ? data.signal.reason
              : new DOMException('Run aborted', 'AbortError'),
          );
        data.signal?.addEventListener('abort', onAbort, { once: true });
        if (data.signal?.aborted) {
          onAbort();
          return;
        }
        unsubscribe = preemption.subscribe?.(interrupt);
        interrupt();
        if (settled) return;
        const request: ToolExecuteBatchRequest = {
          ...data,
          signal,
          resolve: finish,
          reject: fail,
          onResult: (result) => {
            if (settled) return;
            completed.set(result.toolCallId, result);
            data.onResult?.(result);
          },
        };
        try {
          Promise.resolve(handler.handle(event, request, metadata, graph)).catch(fail);
        } catch (error) {
          fail(error instanceof Error ? error : new Error('Tool execution failed'));
        }
      }).finally(() => {
        unsubscribe?.();
        if (onAbort != null) data.signal?.removeEventListener('abort', onAbort);
      });
    },
  };
}
