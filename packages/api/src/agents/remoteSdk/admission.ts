import { z } from 'zod';
import { AsyncLocalStorage } from 'node:async_hooks';
import { ensureHandler } from '@langchain/core/callbacks/manager';
import { HostChatModel, HostModelServiceError } from '@librechat/agents';
import type { BaseCallbackHandler, CallbackHandlerMethods } from '@langchain/core/callbacks/base';
import type { CallbackManagerForLLMRun, Callbacks } from '@langchain/core/callbacks/manager';
import type { ChatGenerationChunk } from '@langchain/core/outputs';
import type { BaseMessage } from '@langchain/core/messages';
import type { InitialModelBoundAdmissionCallback } from '../../middleware/modelBoundContent';
import type { SdkRpc } from './peer';
import { isContentFilterError } from '../../middleware/contentFilter';

export interface RemoteModelAttempt {
  nodeId: string;
  modelId: string;
}
export const modelAttemptSchema: z.ZodType<RemoteModelAttempt> = z
  .object({ nodeId: z.string().uuid(), modelId: z.string().uuid() })
  .strict();
const nodeEndSchema = z.object({ nodeId: z.string().uuid(), completed: z.boolean() }).strict();
const invocationContextSchema = z
  .object({ version: z.literal(1), runId: z.string().uuid() })
  .strict();
/** Additive SDK capability: older SDKs keep the input-only model adapter during rollout. */
export const supportsModelInvocationContext: boolean =
  'invocationContextVersion' in HostChatModel && HostChatModel.invocationContextVersion === 1;
const blocked = () => new HostModelServiceError('blocked');

/** Run each iterator operation inside its scope; constructing an async generator does not enter it. */
async function* scopedStream<T, C>(
  storage: AsyncLocalStorage<C>,
  context: C,
  source: () => AsyncIterable<T>,
): AsyncGenerator<T> {
  const iterator = storage.run(context, () => source()[Symbol.asyncIterator]());
  try {
    for (;;) {
      const next = await storage.run(context, () => iterator.next());
      if (next.done) return;
      yield next.value;
    }
  } finally {
    await storage.run(context, () => iterator.return?.());
  }
}

type Attempt = { nodeId: string; nativeIds: Set<string> };
export interface HostModelLifecycle {
  readonly maxEntries: number;
  attach(callbacks: Callbacks | readonly InitialModelBoundAdmissionCallback[] | undefined): boolean;
  failure(): Error | undefined;
  wrapCallbacks(callbacks: Callbacks | undefined): Callbacks;
  invoke<T>(context: RemoteModelAttempt | undefined, operation: () => Promise<T>): Promise<T>;
  stream<T>(
    context: RemoteModelAttempt | undefined,
    operation: () => AsyncIterable<T>,
  ): AsyncIterable<T>;
  end(data: unknown): boolean;
  dispose(): void;
}

/** Reuse the host's admission callbacks; worker completion cannot substitute for a successful native call. */
export function createHostModelLifecycle(agentId: string, maxEntries: number): HostModelLifecycle {
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 16 || maxEntries > 65536) throw blocked();
  const storage = new AsyncLocalStorage<Attempt>();
  const nodes = new Map<string, { pending: number; successful: boolean }>();
  const usedNodes = new Set<string>();
  const usedModels = new Set<string>();
  let initial: InitialModelBoundAdmissionCallback | undefined;
  let attached = false;
  let disposed = false;
  let policyFailure: Error | undefined;
  let admitted = false;
  const metadata = { agentId, langgraph_node: `agent=${agentId}` };
  const begin = (context: RemoteModelAttempt | undefined): Attempt | undefined => {
    if (disposed || policyFailure) throw policyFailure ?? blocked();
    if (!initial || admitted) return undefined;
    if (!context) throw blocked();
    const { nodeId, modelId } = modelAttemptSchema.parse(context);
    if (usedModels.has(modelId) || usedModels.size >= maxEntries) throw blocked();
    let node = nodes.get(nodeId);
    // This bridge admits one starting root. Parallel/child composition needs its own ownership contract.
    if ((nodes.size > 0 && !node) || (node && node.pending > 0)) throw blocked();
    if (!node) {
      if (usedNodes.has(nodeId) || usedNodes.size >= maxEntries) throw blocked();
      usedNodes.add(nodeId);
      node = { pending: 0, successful: false };
      nodes.set(nodeId, node);
      initial.handleChainStart(
        undefined,
        {},
        nodeId,
        undefined,
        undefined,
        metadata,
        undefined,
        metadata.langgraph_node,
      );
    }
    usedModels.add(modelId);
    node.pending++;
    return { nodeId, nativeIds: new Set() };
  };
  const finish = (attempt: Attempt | undefined, successful: boolean) => {
    if (!attempt || disposed) return;
    const node = nodes.get(attempt.nodeId);
    if (!node) throw blocked();
    node.pending--;
    node.successful ||= successful && attempt.nativeIds.size > 0;
    for (const id of attempt.nativeIds) {
      if (successful) initial?.handleLLMEnd({}, id);
      else initial?.handleLLMError(blocked(), id);
    }
  };
  const translate: NonNullable<CallbackHandlerMethods['handleChatModelStart']> = (...args) => {
    const context = storage.getStore();
    if (!initial || admitted) return;
    if (!context || disposed) throw blocked();
    const runId = args[2];
    if (!context.nativeIds.has(runId) && context.nativeIds.size >= maxEntries) throw blocked();
    context.nativeIds.add(runId);
    initial.handleChatModelStart(
      undefined,
      [],
      runId,
      context.nodeId,
      undefined,
      undefined,
      metadata,
    );
  };
  const wrap = (handler: BaseCallbackHandler | CallbackHandlerMethods) => {
    if (!('name' in handler) || handler.name !== 'librechat-model-bound-content-filter')
      return handler;
    return ensureHandler({
      name: handler.name,
      raiseError: true,
      awaitHandlers: true,
      handleChatModelStart: async (...args) => {
        try {
          if (disposed || policyFailure) throw policyFailure ?? blocked();
          if (!initial || admitted) return await handler.handleChatModelStart?.(...args);
          translate(...args);
          const context = storage.getStore();
          if (!context) throw blocked();
          return await handler.handleChatModelStart?.(
            args[0],
            args[1],
            args[2],
            context.nodeId,
            args[4],
            args[5],
            metadata,
          );
        } catch (error) {
          if (isContentFilterError(error)) policyFailure ??= error;
          throw error;
        }
      },
    });
  };
  return {
    maxEntries,
    failure: () => policyFailure,
    attach(callbacks) {
      if (attached || disposed) throw blocked();
      attached = true;
      const matches = (
        callbacks && 'handlers' in callbacks ? callbacks.handlers : (callbacks ?? [])
      ).filter(
        (handler) =>
          'name' in handler && handler.name === 'librechat-initial-model-bound-admission',
      );
      if (matches.length > 1) throw blocked();
      const candidate = matches[0];
      if (candidate) {
        for (const name of [
          'handleChainStart',
          'handleChatModelStart',
          'handleLLMEnd',
          'handleLLMError',
          'handleChainEnd',
          'handleChainError',
        ] as const)
          if (typeof candidate[name] !== 'function') throw blocked();
        initial = candidate as InitialModelBoundAdmissionCallback;
      }
      return initial != null;
    },
    wrapCallbacks(callbacks) {
      const observer = ensureHandler({
        name: 'librechat-host-model-admission',
        raiseError: true,
        awaitHandlers: true,
        handleChatModelStart: translate,
      });
      if (!callbacks || Array.isArray(callbacks)) return [...(callbacks ?? []).map(wrap), observer];
      const manager = callbacks.copy();
      manager.handlers = manager.handlers.map((handler) => ensureHandler(wrap(handler)));
      manager.inheritableHandlers = manager.inheritableHandlers.map((handler) =>
        ensureHandler(wrap(handler)),
      );
      manager.addHandler(observer, true);
      return manager;
    },
    async invoke(context, operation) {
      const attempt = begin(context);
      let successful = false;
      try {
        const value = attempt ? await storage.run(attempt, operation) : await operation();
        successful = true;
        return value;
      } finally {
        finish(attempt, successful);
      }
    },
    async *stream(context, operation) {
      const attempt = begin(context);
      let successful = false;
      try {
        yield* attempt ? scopedStream(storage, attempt, operation) : operation();
        successful = true;
      } finally {
        finish(attempt, successful);
      }
    },
    end(data) {
      if (!initial || disposed || policyFailure) throw policyFailure ?? blocked();
      const { nodeId, completed } = nodeEndSchema.parse(data);
      const node = nodes.get(nodeId);
      if (!node || node.pending !== 0) throw blocked();
      nodes.delete(nodeId);
      if (completed && node.successful) initial.handleChainEnd({ messages: [{}] }, nodeId);
      else initial.handleChainError(blocked(), nodeId);
      admitted = initial.isAdmitted?.() === true;
      if (admitted) {
        usedModels.clear();
        usedNodes.clear();
      }
      return admitted;
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      for (const nodeId of nodes.keys()) initial?.handleChainError(blocked(), nodeId);
      // Also rejects private admission when failure preceded the first native call.
      initial?.handleChainError(blocked(), 'remote-execution');
      nodes.clear();
      usedModels.clear();
      usedNodes.clear();
    },
  };
}

export interface WorkerModelLifecycle {
  callback: BaseCallbackHandler;
  current(context?: unknown): RemoteModelAttempt | undefined;
  model(options: ConstructorParameters<typeof HostChatModel>[0]): HostChatModel;
}

/** Only callbacks installed on this root execution can enroll a model attempt. No message text is relayed. */
export function createWorkerModelLifecycle(
  agentId: string,
  maxEntries: number,
  peer: { call: SdkRpc },
): WorkerModelLifecycle {
  const parents = new Map<string, string>();
  const nodes = new Set<string>();
  const models = new Map<string, RemoteModelAttempt>();
  const attemptedNodes = new Set<string>();
  const storage = new AsyncLocalStorage<RemoteModelAttempt | undefined>();
  let admitted = false;
  const budget = () => {
    if (parents.size + nodes.size + models.size >= maxEntries) throw blocked();
  };
  const context = (manager?: CallbackManagerForLLMRun) => {
    if (admitted) return undefined;
    const value = manager && models.get(manager.runId);
    if (!value) throw blocked();
    attemptedNodes.add(value.nodeId);
    return value;
  };
  const end = async (nodeId: string, completed: boolean) => {
    parents.delete(nodeId);
    nodes.delete(nodeId);
    for (const [modelId, attempt] of models) if (attempt.nodeId === nodeId) models.delete(modelId);
    if (!attemptedNodes.delete(nodeId)) return;
    const reply = z
      .object({ version: z.literal(1), ok: z.literal(true), admitted: z.boolean() })
      .parse(await peer.call('model.node.end', { nodeId, completed }));
    if (reply.admitted) {
      admitted = true;
      parents.clear();
      nodes.clear();
      models.clear();
      attemptedNodes.clear();
    }
  };
  class CorrelatedHostModel extends HostChatModel {
    override _generate(
      messages: BaseMessage[],
      options: this['ParsedCallOptions'],
      manager?: CallbackManagerForLLMRun,
    ) {
      return storage.run(context(manager), () => super._generate(messages, options));
    }

    override async *_streamResponseChunks(
      messages: BaseMessage[],
      options: this['ParsedCallOptions'],
      manager?: CallbackManagerForLLMRun,
    ): AsyncGenerator<ChatGenerationChunk> {
      yield* scopedStream(storage, context(manager), () =>
        super._streamResponseChunks(messages, options, manager),
      );
    }
  }
  return {
    current(context) {
      if (admitted) return undefined;
      if (supportsModelInvocationContext) {
        const { runId } = invocationContextSchema.parse(context);
        const attempt = models.get(runId);
        if (!attempt) throw blocked();
        attemptedNodes.add(attempt.nodeId);
        return attempt;
      }
      const value = storage.getStore();
      if (!value) throw blocked();
      return value;
    },
    model: (options) =>
      supportsModelInvocationContext
        ? new HostChatModel(options)
        : new CorrelatedHostModel(options),
    callback: ensureHandler({
      name: 'librechat-remote-model-admission',
      raiseError: true,
      awaitHandlers: true,
      handleChainStart: (_chain, _inputs, runId, parentRunId, _tags, metadata, _type, name) => {
        if (admitted) return;
        budget();
        if (parentRunId) parents.set(runId, parentRunId);
        if (name === `agent=${agentId}` && metadata?.langgraph_node === name) nodes.add(runId);
      },
      handleChatModelStart: (_model, _messages, runId, parentRunId, _extra, _tags, metadata) => {
        if (admitted) return;
        if (
          metadata?.summarization === true ||
          metadata?.agentId !== agentId ||
          metadata.langgraph_node !== `agent=${agentId}`
        )
          return;
        const seen = new Set<string>();
        let parent = parentRunId;
        while (parent && !seen.has(parent)) {
          if (nodes.has(parent)) {
            budget();
            models.set(runId, { nodeId: parent, modelId: runId });
            return;
          }
          seen.add(parent);
          parent = parents.get(parent);
        }
      },
      handleChainEnd: async (output, runId) => {
        if (admitted) return;
        if (!nodes.has(runId)) {
          parents.delete(runId);
          return;
        }
        const result = output as { messages?: unknown; summarizationRequest?: unknown } | null;
        await end(
          runId,
          Array.isArray(result?.messages) &&
            result.messages.length > 0 &&
            result.summarizationRequest == null,
        );
      },
      handleChainError: (_error, runId) => (admitted ? undefined : end(runId, false)),
    }),
  };
}
