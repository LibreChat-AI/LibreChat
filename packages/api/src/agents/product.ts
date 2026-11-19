import { randomUUID } from 'node:crypto';
import { Constants, GraphEvents } from '@librechat/agents';
import type { CallbackHandlerMethods } from '@langchain/core/callbacks/base';
import type { ChatGeneration } from '@langchain/core/outputs';
import type { ChatServerFact } from 'librechat-data-provider';
import type { EventHandler } from '@librechat/agents';
import type { ToolExecutionIdentity } from '~/telemetry/tools';
import type { ProductToolIdentity } from '~/tracking/tools';
import type { ServerRequest } from '~/types';
import { trackRequestProductFact } from '~/tracking/request';
import { observeToolExecution } from '~/telemetry/tools';
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

export type ProductChildRuns = Map<string, { runId: string; parentRunId?: string }>;

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

/** Root graph participants may run concurrently; another model start never ends one. */
export function createProductAgentLifecycle(req: ProductTrackingRequest | undefined): {
  start: (context: ExecutionContext) => void;
  finish: (outcome: 'completed' | 'failed' | 'cancelled') => void;
} {
  type Invocation = Extract<ChatServerFact, { name: 'librechat.chat.agent.invoked' }>;
  const active = new Map<string, Invocation>();
  return {
    start(context: ExecutionContext): void {
      if (!context.runId || !context.agentId || context.usage_type === 'subagent') return;
      const key = `${context.runId}:${context.agentId}`;
      if (active.has(key)) return;
      const invocation: Invocation = {
        name: 'librechat.chat.agent.invoked',
        feature: 'chat',
        runId: context.runId,
        agentId: context.agentId,
        agentInvocationId: randomUUID(),
        conversationId: context.conversationId,
        model: context.model,
        provider: context.provider,
        parentRunId: context.parentRunId,
      };
      active.set(key, invocation);
      emit(req, invocation);
    },
    finish(outcome): void {
      // Overall success proves all participants completed. A root failure or stop
      // does not identify which parallel participant had already finished.
      if (outcome === 'completed') {
        for (const invocation of active.values()) {
          emit(req, { ...invocation, name: 'librechat.chat.agent.finished', outcome });
        }
      }
      active.clear();
    },
  };
}

/** Intrinsic model callbacks survive fallback, summarization and nested graph execution. */
export function createProductModelCallback(
  req: ProductTrackingRequest | undefined,
  context: ExecutionContext,
  signal: AbortSignal | undefined,
  agents?: ReturnType<typeof createProductAgentLifecycle>,
  childRuns?: ProductChildRuns,
): CallbackHandlerMethods | undefined {
  if (req?.productTracking?.enabled !== true || req.productTracker == null) return undefined;
  const calls = new Map<string, ExecutionContext & { parentCallId?: string }>();
  return {
    handleChatModelStart: (_model, _messages, callId, parentCallId, _extra, _tags, metadata) => {
      // The SDK keeps configurable.run_id as the root hook scope. Only a child
      // lifecycle identity proves that metadata.messageId names this child graph.
      const child = childRuns?.get(label(metadata?.messageId) ?? '');
      const call = {
        ...context,
        ...(childRuns
          ? { runId: child?.runId, parentRunId: child?.parentRunId ?? context.parentRunId }
          : {}),
        parentCallId,
        agentId: label(metadata?.executingAgentId) ?? label(metadata?.agentId) ?? context.agentId,
        model:
          label(metadata?.ls_model_name) ??
          label(metadata?.[Constants.INVOKED_MODEL]) ??
          context.model,
        provider: label(metadata?.[Constants.INVOKED_PROVIDER]) ?? context.provider,
      };
      calls.set(callId, call);
      agents?.start(call);
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

function isFailedToolResult(result: unknown): boolean {
  try {
    return (
      result != null &&
      typeof result === 'object' &&
      (('status' in result && result.status === 'error') ||
        ('isError' in result && result.isError === true))
    );
  } catch {
    return false;
  }
}

/** Adds product facts around the existing actual-execution observer, without retaining payloads. */
export function createProductToolObserver(
  req: ProductTrackingRequest | undefined,
  resolveTool?: (name: string) => ProductToolIdentity,
): typeof observeToolExecution {
  return async function observeProductTool<T>(
    identity: ToolExecutionIdentity,
    execute: () => Promise<T>,
    options: Parameters<typeof observeToolExecution>[2] = {},
  ): Promise<T> {
    if (identity.toolName === Constants.SKILL_TOOL || req?.productTracking?.enabled !== true) {
      return observeToolExecution(identity, execute, options);
    }
    const startedAt = performance.now();
    let productTool: ProductToolIdentity = { toolCategory: 'custom' };
    try {
      productTool = resolveTool?.(identity.toolName) ?? productTool;
    } catch {
      // Missing analytics metadata must not prevent tool execution.
    }
    const context = {
      feature: 'chat' as const,
      toolCallId: identity.toolCallId,
      ...productTool,
      mode: identity.mode,
      runId: identity.runId,
      conversationId: identity.conversationId,
      agentId: identity.agentId,
      parentRunId: identity.parentRunId,
      parentToolCallId: identity.parentToolCallId,
    };
    emit(req, { name: 'librechat.chat.tool.invoked', ...context });
    try {
      const result = await observeToolExecution(identity, execute, options);
      const failed = isFailedToolResult(result);
      emit(req, {
        name: 'librechat.chat.tool.finished',
        ...context,
        outcome: failed ? 'failed' : 'completed',
        durationMs: performance.now() - startedAt,
      });
      return result;
    } catch (error) {
      const source = options?.getAbortSource?.();
      emit(req, {
        name: 'librechat.chat.tool.finished',
        ...context,
        outcome:
          isOwnedAbortError(error, options?.signal) && (source == null || source === 'manual')
            ? 'cancelled'
            : 'failed',
        durationMs: performance.now() - startedAt,
      });
      throw error;
    }
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
  agents?: ReturnType<typeof createProductAgentLifecycle>,
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
      const finish = (outcome: 'completed' | 'failed' | 'cancelled') => {
        if (!outermost || finished) return;
        finished = true;
        emit(req, {
          name: 'librechat.chat.response.finished',
          feature: 'chat',
          ...context,
          outcome,
          durationMs: performance.now() - startedAt!,
        });
        agents?.finish(outcome);
      };
      try {
        const result = await original(...args);
        if (!run.getInterrupt()) {
          let outcome: 'completed' | 'cancelled' | 'failed' = 'completed';
          if (run.getHaltReason()) outcome = 'failed';
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

/** Child runs report their own identity before any stream visibility filter runs. */
export function createProductEventHandlers(
  handlers: Record<string, EventHandler> | undefined,
  req: ProductTrackingRequest | undefined,
  context: ExecutionContext,
  childRuns?: ProductChildRuns,
): Record<string, EventHandler> | undefined {
  if (req?.productTracking?.enabled !== true || req.productTracker == null) return handlers;
  const existing = handlers?.[GraphEvents.ON_SUBAGENT_UPDATE];
  const cancelled = new Set<string>();
  return {
    ...handlers,
    [GraphEvents.ON_SUBAGENT_UPDATE]: {
      handle: async (event, data, metadata, graph) => {
        if (
          data != null &&
          'phase' in data &&
          'subagentRunId' in data &&
          'subagentAgentId' in data
        ) {
          childRuns?.set(data.subagentRunId, {
            runId: data.subagentRunId,
            parentRunId: data.parentRunId ?? context.runId,
          });
          const child = {
            feature: 'chat' as const,
            conversationId: context.conversationId,
            runId: data.subagentRunId,
            parentRunId: data.parentRunId ?? context.runId,
            agentId: data.subagentAgentId,
            agentInvocationId: data.subagentRunId,
          };
          if (
            data.phase === 'run_step_closed' &&
            data.data != null &&
            typeof data.data === 'object' &&
            'status' in data.data &&
            data.data.status === 'cancelled'
          ) {
            cancelled.add(data.subagentRunId);
          }
          if (data.phase === 'start') {
            emit(req, { name: 'librechat.chat.agent.invoked', ...child });
          } else if (data.phase === 'stop' || data.phase === 'error') {
            let outcome: 'completed' | 'cancelled' | 'failed' = 'completed';
            if (data.phase === 'error')
              outcome = cancelled.has(data.subagentRunId) ? 'cancelled' : 'failed';
            emit(req, {
              name: 'librechat.chat.agent.finished',
              ...child,
              outcome,
            });
            cancelled.delete(data.subagentRunId);
          }
        }
        await existing?.handle(event, data, metadata, graph);
      },
    },
  };
}

/** Remote runtimes forward model results, not local callback instances. */
export function createProductRemoteModelHandlers(
  handlers: Record<string, EventHandler> | undefined,
  req: ProductTrackingRequest | undefined,
  context: ExecutionContext,
  agents: ReturnType<typeof createProductAgentLifecycle>,
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
        agents.start(call);
        const output = data != null && 'output' in data ? data.output : undefined;
        const usage = getModelEndUsage(output as Parameters<typeof getModelEndUsage>[0]);
        emit(req, {
          name: 'librechat.chat.model.usage.recorded',
          feature: 'chat',
          ...call,
          callId: randomUUID(),
          usage_scope: 'call',
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
