import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { GraphEvents } from '@librechat/agents';
import type {
  EventHandler,
  HostToolDescriptor,
  HostToolRequest,
  HostToolService,
  HostToolEvents,
  HostToolSessionUpdate,
  ToolExecuteResult,
} from '@librechat/agents';
import type { SdkAgentIdentity } from './identity';
import type { SdkRpc } from './peer';

const toolResultSchema = z.object({
  id: z.string().uuid(),
  result: z
    .object({ toolCallId: z.string().min(1), status: z.enum(['success', 'error']) })
    .passthrough(),
});

/** Local credentials/configuration are supplied by the authenticated host, never by the worker. */
export function createHostToolService(options: {
  identity: Readonly<SdkAgentIdentity>;
  tools: HostToolDescriptor[];
  handler: EventHandler;
  graph?: Parameters<EventHandler['handle']>[3];
  configurable: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  peer: { call: SdkRpc };
  signal: AbortSignal;
}): (data: unknown) => Promise<ToolExecuteResult[]> {
  const references = new Map(options.tools.map((t) => [t.definition.name, t.reference]));
  return async (data: unknown): Promise<ToolExecuteResult[]> => {
    const envelope = z
      .object({
        id: z.string().uuid(),
        incremental: z.boolean(),
        request: z.object({
          version: z.literal(1),
          identity: z.record(z.string(), z.unknown()),
          executingAgentId: z.string().optional(),
          executionContext: z.unknown().optional(),
          callerCapabilityProjection: z.unknown().optional(),
          calls: z
            .array(
              z.object({
                reference: z.string(),
                call: z
                  .object({
                    id: z.string().min(1),
                    name: z.string(),
                    args: z.record(z.string(), z.unknown()),
                  })
                  .passthrough(),
              }),
            )
            .min(1),
        }),
      })
      .parse(data);
    const request = envelope.request as HostToolRequest;
    for (const key of [
      'runtimeId',
      'agentId',
      'runId',
      'userId',
      'tenantId',
      'conversationId',
    ] as const)
      if (request.identity[key] !== options.identity[key])
        throw new Error('Host tool identity mismatch');
    if (
      request.executionContext !== undefined ||
      (request.executingAgentId !== undefined &&
        request.executingAgentId !== options.identity.agentId)
    )
      throw new Error('Host tool execution subject is unsupported');
    const ids = new Set<string>();
    for (const { call, reference } of request.calls) {
      if (references.get(call.name) !== reference || ids.has(call.id))
        throw new Error('Host tool capability mismatch');
      ids.add(call.id);
    }
    options.signal.throwIfAborted();
    const notifications: Promise<unknown>[] = [];
    let active = true;
    let resolve!: (results: ToolExecuteResult[]) => void;
    let reject!: (error: Error) => void;
    const result = new Promise<ToolExecuteResult[]>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    // Install rejection handling before invoking a handler that may reject synchronously.
    void result.catch(() => undefined);
    try {
      await options.handler.handle(
        GraphEvents.ON_TOOL_EXECUTE,
        {
          toolCalls: request.calls.map((c) => c.call),
          userId: options.identity.userId,
          agentId: options.identity.agentId,
          configurable: options.configurable,
          metadata: options.metadata,
          callerCapabilityProjection: request.callerCapabilityProjection,
          signal: options.signal,
          resolve,
          reject,
          ...(envelope.incremental
            ? {
                onResult: (value: ToolExecuteResult) => {
                  if (!active || options.signal.aborted) return;
                  if (!ids.has(value.toolCallId))
                    throw new Error('Invalid incremental tool receipt');
                  const notice = options.peer.call('tool.result', {
                    id: envelope.id,
                    result: value,
                  });
                  void notice.catch(() => undefined);
                  notifications.push(notice);
                },
              }
            : {}),
        },
        options.metadata,
        options.graph,
      );
      const results = await result;
      active = false;
      await Promise.all(notifications);
      options.signal.throwIfAborted();
      return results;
    } finally {
      active = false;
      for (const { call } of request.calls) {
        notifications.push(
          options.peer.call('tool.session', {
            id: envelope.id,
            update: {
              toolCallId: call.id,
              context: {
                codeSessionContext: call.codeSessionContext,
                codeSessionBaselineId: call.codeSessionBaselineId,
                retainCodeSessionInputs: call.retainCodeSessionInputs,
                runtimeSessionHint: call.runtimeSessionHint,
              },
            },
          }),
        );
      }
      await Promise.all(notifications);
    }
  };
}

export function createWorkerToolService(peer: { call: SdkRpc }): {
  service: HostToolService;
  accept: (data: unknown, kind?: 'result' | 'session') => null;
} {
  const pending = new Map<string, HostToolEvents>();
  return {
    service: {
      version: 1,
      invoke: async (request, signal, events) => {
        signal?.throwIfAborted();
        const id = randomUUID();
        if (events) pending.set(id, events);
        try {
          return (await peer.call('tools', {
            id,
            request,
            incremental: Boolean(events?.onResult),
          })) as ToolExecuteResult[];
        } finally {
          pending.delete(id);
        }
      },
    },
    accept: (data, kind = 'result') => {
      if (kind === 'session') {
        const value = z
          .object({
            id: z.string().uuid(),
            update: z
              .object({
                toolCallId: z.string(),
                context: z
                  .object({
                    codeSessionContext: z.unknown().optional(),
                    codeSessionBaselineId: z.string().optional(),
                    retainCodeSessionInputs: z.literal(true).optional(),
                    runtimeSessionHint: z.string().optional(),
                  })
                  .strict(),
              })
              .strict(),
          })
          .parse(data);
        const events = pending.get(value.id);
        if (!events) throw new Error('Unknown tool session invocation');
        events.onSessionUpdate(value.update as HostToolSessionUpdate);
        return null;
      }
      const value = toolResultSchema.parse(data);
      const handler = pending.get(value.id);
      if (!handler) throw new Error('Unknown tool result invocation');
      handler.onResult?.(value.result as ToolExecuteResult);
      return null;
    },
  };
}
