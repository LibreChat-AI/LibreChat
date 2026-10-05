import type {
  ToolExecuteBatchRequest,
  ToolExecuteResult,
  StreamPreemption,
  EventHandler,
} from '@librechat/agents';

/** Host-only admission channel; artifacts may still be validating after execution finishes. */
export interface InterruptibleToolBatchRequest extends ToolExecuteBatchRequest {
  onArtifactDeliveryStart?: (toolCallId: string) => void;
}

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
      const delivering = new Set<string>();
      let interrupted = false;
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
        const finishInterrupt = () => {
          if (!interrupted || delivering.size > 0) return;
          finish(
            data.toolCalls.map((call) => completed.get(call.id) ?? interruptedToolResult(call.id)),
          );
        };
        const interrupt = () => {
          if (settled || interrupted || data.signal?.aborted || !preemption.shouldPreempt()) return;
          interrupted = true;
          controller.abort(new SteerToolInterrupt());
          finishInterrupt();
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
        const request: InterruptibleToolBatchRequest = {
          ...data,
          signal,
          resolve: (results) => (interrupted ? finishInterrupt() : finish(results)),
          reject: fail,
          onArtifactDeliveryStart: (toolCallId) => {
            if (!settled && !interrupted) delivering.add(toolCallId);
          },
          onResult: (result) => {
            if (settled || (interrupted && !delivering.has(result.toolCallId))) return;
            completed.set(result.toolCallId, result);
            delivering.delete(result.toolCallId);
            data.onResult?.(result);
            finishInterrupt();
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
