import { randomUUID } from 'node:crypto';
import { Constants, GraphEvents } from '@librechat/agents';
import type { CallbackHandlerMethods } from '@langchain/core/callbacks/base';
import type { ChatGeneration } from '@langchain/core/outputs';
import type { ChatServerFact } from 'librechat-data-provider';
import type { EventHandler } from '@librechat/agents';
import type { ServerRequest } from '~/types';
import { trackRequestProductFact } from '~/tracking/request';
import { isOwnedAbortError } from '~/utils/errors';
import { getModelEndUsage } from './usage';

export type ProductTrackingRequest = Pick<
  ServerRequest,
  'productTracker' | 'productTracking' | 'productTrackingContext'
>;
type ModelFact = Extract<ChatServerFact, { name: 'librechat.chat.model.usage.recorded' }>;
export type ExecutionContext = Pick<
  ModelFact,
  'runId' | 'conversationId' | 'agentId' | 'model' | 'provider' | 'parentRunId' | 'usage_type'
>;

function label(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function cacheDetails(
  usage: ReturnType<typeof getModelEndUsage>,
): ModelFact['input_token_details'] {
  if (!usage) return undefined;
  const details = usage.input_token_details;
  const cache_creation = count(
    details?.cache_creation ??
      details?.cache_write_tokens ??
      usage.cache_creation_input_tokens ??
      usage.cache_write_tokens,
  );
  const cache_read = count(details?.cache_read ?? usage.cache_read_input_tokens);
  if (details == null && cache_creation == null && cache_read == null) return undefined;
  return {
    cache_creation,
    cache_read,
    cache_creation_1h: count(details?.cache_creation_1h),
    cache_creation_12h: count(details?.cache_creation_12h),
  };
}

/** Uses the request-owned callback. Tracking failures never change an execution result. */
function emit(req: ProductTrackingRequest | undefined, fact: ChatServerFact): void {
  if (req) trackRequestProductFact(req, fact);
}

/** Intrinsic model callbacks survive fallback, summarization and nested graph execution. */
export function createProductModelCallback(
  req: ProductTrackingRequest | undefined,
  context: ExecutionContext,
  signal: AbortSignal | undefined,
): CallbackHandlerMethods | undefined {
  if (req?.productTracking?.enabled !== true || req.productTracker == null) return undefined;
  const calls = new Map<string, ExecutionContext & { parentCallId?: string }>();
  return {
    handleChatModelStart: (_model, _messages, callId, parentCallId, _extra, _tags, metadata) => {
      const call = {
        ...context,
        parentCallId,
        agentId: label(metadata?.executingAgentId) ?? label(metadata?.agentId) ?? context.agentId,
        model:
          label(metadata?.ls_model_name) ??
          label(metadata?.[Constants.INVOKED_MODEL]) ??
          context.model,
        provider: label(metadata?.[Constants.INVOKED_PROVIDER]) ?? context.provider,
      };
      calls.set(callId, call);
    },
    handleLLMEnd: (output, callId) => {
      const call = calls.get(callId);
      calls.delete(callId);
      const generation = output.generations[0]?.[0];
      const message =
        generation && 'message' in generation ? (generation as ChatGeneration).message : undefined;
      const usage = getModelEndUsage(message as Parameters<typeof getModelEndUsage>[0]);
      const tokenUsage = output.llmOutput?.tokenUsage;
      emit(req, {
        name: 'librechat.chat.model.usage.recorded',
        feature: 'chat',
        ...context,
        ...call,
        callId,
        outcome: 'completed',
        input_tokens: count(
          usage?.input_tokens ?? tokenUsage?.promptTokens ?? tokenUsage?.prompt_tokens,
        ),
        output_tokens: count(
          usage?.output_tokens ?? tokenUsage?.completionTokens ?? tokenUsage?.completion_tokens,
        ),
        total_tokens: count(
          usage?.total_tokens ?? tokenUsage?.totalTokens ?? tokenUsage?.total_tokens,
        ),
        input_token_details: cacheDetails(usage),
      });
    },
    handleLLMError: (error, callId) => {
      const call = calls.get(callId);
      calls.delete(callId);
      emit(req, {
        name: 'librechat.chat.model.usage.recorded',
        feature: 'chat',
        ...context,
        ...call,
        callId,
        outcome: isOwnedAbortError(error, signal) ? 'cancelled' : 'failed',
      });
    },
  };
}

/** Reports only a settled invocation. Paused runs and disconnected browsers do not finish it. */
export function observeProductRun<
  T extends {
    processStream: (...args: never[]) => Promise<unknown>;
    resume?: (...args: never[]) => Promise<unknown>;
    getInterrupt: () => unknown;
    getHaltReason: () => string | undefined;
  },
>(
  run: T,
  req: ProductTrackingRequest | undefined,
  context: ExecutionContext & { runId: string },
  signal: AbortSignal,
): T {
  if (req?.productTracking?.enabled !== true || req.productTracker == null) return run;
  let startedAt: number | undefined;
  let finished = false;
  let invocationDepth = 0;
  const wrap =
    (original: (...args: never[]) => Promise<unknown>) =>
    async (...args: never[]) => {
      const outermost = invocationDepth++ === 0;
      startedAt ??= performance.now();
      const finish = (outcome: 'completed' | 'incomplete' | 'failed' | 'cancelled') => {
        if (!outermost || finished) return;
        finished = true;
        emit(req, {
          name: 'librechat.chat.response.finished',
          feature: 'chat',
          ...context,
          outcome,
          durationMs: performance.now() - startedAt!,
        });
      };
      try {
        const result = await original(...args);
        if (!run.getInterrupt()) {
          let outcome: 'completed' | 'incomplete' | 'cancelled' = 'completed';
          if (run.getHaltReason()) outcome = 'incomplete';
          if (signal.aborted) outcome = 'cancelled';
          finish(outcome);
        }
        return result;
      } catch (error) {
        finish(isOwnedAbortError(error, signal) ? 'cancelled' : 'failed');
        throw error;
      } finally {
        invocationDepth--;
      }
    };
  run.processStream = wrap(run.processStream.bind(run));
  if (run.resume) run.resume = wrap(run.resume.bind(run));
  return run;
}

/** Remote runtimes forward model results, not local callback instances. */
export function createProductRemoteModelHandlers(
  handlers: Record<string, EventHandler> | undefined,
  req: ProductTrackingRequest | undefined,
  context: ExecutionContext,
): Record<string, EventHandler> | undefined {
  if (req?.productTracking?.enabled !== true || req.productTracker == null) return handlers;
  const existing = handlers?.[GraphEvents.CHAT_MODEL_END];
  return {
    ...handlers,
    [GraphEvents.CHAT_MODEL_END]: {
      handle: async (event, data, metadata, graph) => {
        const call = {
          ...context,
          agentId: label(metadata?.agentId) ?? label(metadata?.langgraph_node) ?? context.agentId,
          model:
            label(metadata?.ls_model_name) ??
            label(metadata?.[Constants.INVOKED_MODEL]) ??
            context.model,
          provider: label(metadata?.[Constants.INVOKED_PROVIDER]) ?? context.provider,
        };
        const output = data != null && 'output' in data ? data.output : undefined;
        const usage = getModelEndUsage(output as Parameters<typeof getModelEndUsage>[0]);
        emit(req, {
          name: 'librechat.chat.model.usage.recorded',
          feature: 'chat',
          ...call,
          callId: randomUUID(),
          outcome: 'completed',
          input_tokens: count(usage?.input_tokens),
          output_tokens: count(usage?.output_tokens),
          total_tokens: count(usage?.total_tokens),
          input_token_details: cacheDetails(usage),
        });
        await existing?.handle(event, data, metadata, graph);
      },
    },
  };
}

/** Adds an observer without changing the caller's existing provider callbacks. */
export function withProductModelCallbacks<T>(
  callbacks: T[],
  req: ProductTrackingRequest | undefined,
  context: ExecutionContext,
  signal?: AbortSignal,
): Array<T | CallbackHandlerMethods> {
  const observer = createProductModelCallback(req, context, signal);
  return observer ? [...callbacks, observer] : callbacks;
}

/** Setup failure ends this accepted generation before any agent or model starts. */
export async function observeProductRunSetup<T>(
  req: ProductTrackingRequest | undefined,
  context: ExecutionContext & { runId: string },
  signal: AbortSignal,
  create: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await create();
  } catch (error) {
    emit(req, {
      name: 'librechat.chat.response.finished',
      feature: 'chat',
      ...context,
      outcome: isOwnedAbortError(error, signal) ? 'cancelled' : 'failed',
      durationMs: performance.now() - startedAt,
    });
    throw error;
  }
}
