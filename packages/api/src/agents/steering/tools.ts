import type {
  ToolExecuteBatchRequest,
  ToolExecuteResult,
  StreamPreemption,
  EventHandler,
  AgentInputs,
} from '@librechat/agents';

/** The pinned SDK cannot cancel unanswered provider-hosted tools without orphaning them. */
export function supportsRunInterruption(agents: readonly AgentInputs[]): boolean {
  return agents.every((agent) => {
    if (agent.tools?.some((tool) => !('invoke' in tool) || typeof tool.invoke !== 'function'))
      return false;
    const plugins = (
      agent.clientOptions as { modelKwargs?: { plugins?: Array<{ id?: string }> } } | undefined
    )?.modelKwargs?.plugins;
    return !plugins?.some((plugin) => plugin.id === 'web');
  });
}

/** Host-only admission channel for durable claims and completed-output validation. */
export interface InterruptibleToolBatchRequest extends ToolExecuteBatchRequest {
  onResultAdmissionStart?: (toolCallId: string) => void;
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
      const admitted = new Set<string>();
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
          if (interrupted && error instanceof SteerToolInterrupt && !data.signal?.aborted) {
            finishInterrupt();
            return;
          }
          settled = true;
          data.reject(error);
          reject(error);
        };
        const finishInterrupt = () => {
          if (!interrupted || admitted.size > 0) return;
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
          onResultAdmissionStart: (toolCallId) => {
            if (!settled && !interrupted) admitted.add(toolCallId);
          },
          onResult: (result) => {
            if (settled || (interrupted && !admitted.has(result.toolCallId))) return;
            completed.set(result.toolCallId, result);
            admitted.delete(result.toolCallId);
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
