import type { EventHandler } from '@librechat/agents';
import type { ServerToolResult, ChatCompletionChunkChoice, ServerToolResultFields } from './types';

/** Public-payload safety guards, separate from tool execution limits. Exhaustion
 * stops observation, never the graph. Match the SDK client-call projection's
 * 1024-call/4-MiB envelope; hosts may inject smaller budgets for their transport. */
const MAX_RESULTS = 1024;
const MAX_BYTES = 4 * 1024 * 1024;

type Projection = {
  handlers: Record<string, EventHandler>;
  finish: () => void;
  abort: () => void;
};

type Options = {
  signal?: AbortSignal;
  emit?: (delta: ChatCompletionChunkChoice['delta']) => void;
  maxCalls?: number;
  maxBytes?: number;
};

function record(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

export function validateChatIncludes(value: unknown): string | undefined {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((item) => item !== 'server_tool_results'))
    return 'include must be an array containing only server_tool_results';
}

export interface ServerToolResults {
  readonly incomplete: boolean;
  response(): ServerToolResultFields;
  wrap<T extends Projection>(projection: T): T;
}

/** Captures only SDK-accepted, server-executed completions. Raw tool-end content
 * and artifacts are deliberately outside this public projection. */
export function createServerToolResults({
  signal,
  emit,
  maxCalls = MAX_RESULTS,
  maxBytes = MAX_BYTES,
}: Options = {}): ServerToolResults {
  const pending = new Map<string, { name: string }>();
  const announcements = new Set<string>();
  const completed = new Set<string>();
  const results: ServerToolResult[] = [];
  let count = 0;
  let bytes = 0;
  let index = 0;
  let incomplete = false;
  let fenced = false;
  let closed = false;
  let finished = false;

  const release = () => {
    pending.clear();
    announcements.clear();
    completed.clear();
  };
  const abort = () => {
    closed = true;
    release();
    if (!finished) {
      results.length = 0;
      incomplete = false;
    }
  };
  const active = () => {
    if (!closed && signal?.aborted) abort();
    return !closed && !fenced;
  };
  const reserve = (...values: string[]) => {
    let size = 0;
    for (const value of values) size += Buffer.byteLength(value, 'utf8');
    if (bytes + size > maxBytes) {
      incomplete = fenced = true;
      release();
      return false;
    }
    bytes += size;
    return true;
  };
  const accept = (data: unknown) => {
    if (
      !active() ||
      !record(data) ||
      data.type !== 'model_response' ||
      typeof data.agentId !== 'string' ||
      typeof data.id !== 'string' ||
      !data.id ||
      !Array.isArray(data.toolCalls) ||
      !Array.isArray(data.toolCallDispositions)
    )
      return;
    if (data.agentId.length + data.id.length > maxBytes) {
      incomplete = fenced = true;
      release();
      return;
    }
    const announcement = JSON.stringify([data.agentId, data.id]);
    if (announcements.has(announcement)) return;
    const dispositions = data.toolCallDispositions;
    if (dispositions.length !== data.toolCalls.length) return;
    for (let i = 0; i < data.toolCalls.length; i++) {
      if (dispositions[i] !== 'sdk') continue;
      const call: unknown = data.toolCalls[i];
      if (
        !record(call) ||
        typeof call.id !== 'string' ||
        !call.id ||
        typeof call.name !== 'string' ||
        !call.name
      )
        continue;
      if (count >= maxCalls) {
        incomplete = fenced = true;
        release();
        return;
      }
      if (!reserve(data.agentId, call.id, call.name)) return;
      if (!announcements.has(announcement)) {
        if (!reserve(data.id)) return;
        announcements.add(announcement);
      }
      const key = JSON.stringify([data.agentId, call.id]);
      pending.set(key, { name: call.name });
      count++;
    }
  };
  const complete = (data: unknown, metadata: unknown) => {
    if (!active() || !record(data) || !record(data.result)) return;
    const step = data.result;
    const call = step.tool_call;
    if (
      step.type !== 'tool_call' ||
      typeof step.id !== 'string' ||
      !step.id ||
      !record(call) ||
      typeof call.id !== 'string' ||
      !call.id ||
      typeof call.args !== 'string' ||
      typeof call.output !== 'string'
    )
      return;
    // SDK 4.2.10 ToolNode.withToolScope stamps this execution owner on
    // completion metadata. Never infer an owner from a pending call ID:
    // provider/client siblings can reuse that ID without entering this collector.
    const owner = record(metadata) ? metadata.agentId : undefined;
    if (typeof owner !== 'string' || !owner) {
      incomplete = true;
      return;
    }
    if (call.id.length > maxBytes || step.id.length > maxBytes || owner.length > maxBytes) return;
    const key = JSON.stringify([owner, call.id]);
    const accepted = pending.get(key);
    if (!accepted || call.name !== accepted.name) return;
    const identity = JSON.stringify([key, step.id]);
    if (completed.has(identity)) return;
    if (!reserve(step.id, call.args, call.output)) return;
    completed.add(identity);
    pending.delete(key);
    const result: ServerToolResult = {
      call_id: call.id,
      name: accepted.name,
      arguments: call.args,
      output: call.output,
    };
    if (emit) emit({ tool_results: [{ index: index++, ...result }] });
    else results.push(result);
  };
  return {
    get incomplete(): boolean {
      return incomplete;
    },
    response(): ServerToolResultFields {
      return {
        tool_results: results,
        ...(incomplete && { tool_results_incomplete: true as const }),
      };
    },
    wrap<T extends Projection>(projection: T): T {
      const accepted = projection.handlers.on_model_response;
      return {
        ...projection,
        handlers: {
          ...projection.handlers,
          on_model_response: {
            async handle(event, data, metadata, graph) {
              await accepted.handle(event, data, metadata, graph);
              if (event === 'on_model_response') accept(data);
            },
          },
          on_run_step_completed: {
            handle(event, data, metadata) {
              if (event === 'on_run_step_completed') complete(data, metadata);
            },
          },
        },
        finish() {
          if (finished) return;
          const check = () => {
            if (!signal?.aborted) return;
            abort();
            const error = new Error('Agent response aborted');
            error.name = 'AbortError';
            throw error;
          };
          check();
          if (closed) return;
          projection.finish();
          check();
          finished = true;
          closed = true;
          release();
        },
        abort() {
          abort();
          projection.abort();
        },
      };
    },
  };
}
