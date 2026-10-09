import { createMetadataAggregator } from '@librechat/agents';
import { ContentTypes, ReasoningLabelEvents } from 'librechat-data-provider';
import type { HandleLLMEnd, Providers } from '@librechat/agents';
import type {
  GeneratedReasoningLabel,
  GenerateReasoningLabelPayload,
  ReasoningLabelAttemptEvent,
  ReasoningLabelEvent,
  ReasoningLabelHostDeps,
  ReasoningLabelStatus,
  ReasoningLabelWiring,
} from './runtime';
import type { ResolvedReasoningLabelConfig } from '~/agents/activityLabels/host';
import type { ActivityLabelLLM } from '~/agents/activityLabels/runtime';
import type { LooseContentPart } from '~/agents/activityLabels/wiring';
import { createReasoningLabelWiring } from './runtime';

type ReasoningLabelUsageMetadata = Record<string, unknown>;
type ReasoningLabelLLMOutput = Parameters<HandleLLMEnd>[0];

interface ReasoningLabelPromptMessage {
  content: unknown;
}

interface ReasoningLabelCaptureCallback {
  handleLLMStart: (_llm: unknown, prompts: string[]) => void;
  handleChatModelStart: (_llm: unknown, messages: ReasoningLabelPromptMessage[][]) => void;
  handleLLMEnd: HandleLLMEnd;
}

interface ReasoningLabelSDKOptions {
  provider: Providers;
  clientOptions: ActivityLabelLLM['clientOptions'];
  visibleReasoning: string;
  reasoningStepId: string;
  revision: number;
  status: ReasoningLabelStatus;
  previousLabel?: string;
  agentId?: string;
  charLimit: number;
  prompt?: string;
  sourceRunId: string;
  sourceTraceId: string;
  responseId: string;
  chainOptions: {
    signal: AbortSignal;
    callbacks: ReasoningLabelCaptureCallback[];
    configurable: {
      thread_id: string;
      user_id?: string;
      requestBody: { parentMessageId?: string };
    };
  };
}

export interface ReasoningLabelRun {
  generateReasoningLabel: (
    options: ReasoningLabelSDKOptions,
  ) => Promise<{ label?: string; usage?: ReasoningLabelUsageMetadata }>;
}

export interface ReasoningLabelUsageRecord {
  collectedMetadata: Record<string, unknown>[];
  model?: string;
  endpointTokenConfig?: unknown;
  sameEndpoint?: boolean;
  provider: Providers;
  promptText: string;
  completionText: string;
}

export interface GenerateReasoningLabelRevisionOptions {
  payload: GenerateReasoningLabelPayload;
  run?: ReasoningLabelRun;
  resolveModel: () => Promise<ActivityLabelLLM>;
  sourceRunId: string;
  sourceTraceId: string;
  responseId: string;
  sessionId: string;
  userId?: string;
  parentMessageId?: string;
  recordUsage: (usage: ReasoningLabelUsageRecord) => void | Promise<void>;
  onError?: (error: unknown) => void;
}

export interface ReasoningLabelHostScope {
  closed: boolean;
  abort: AbortController;
  detach?: () => void;
}

type ReasoningLabelDurableEvent = ReasoningLabelAttemptEvent | ReasoningLabelEvent;

export interface CreateReasoningLabelHostWiringOptions {
  config: ResolvedReasoningLabelConfig;
  seedFromContent?: boolean;
  abortSignal?: AbortSignal;
  markResumable?: () => Promise<unknown>;
  onMarkFailure?: () => void;
  getContentParts: ReasoningLabelHostDeps['getContentParts'];
  getStepIndex: ReasoningLabelHostDeps['getStepIndex'];
  emitEvent: (event: ReasoningLabelEvents, data: ReasoningLabelDurableEvent) => Promise<unknown>;
  trackPendingFill: ReasoningLabelHostDeps['trackPendingFill'];
  generateLabel: ReasoningLabelHostDeps['generateLabel'];
}

export interface ReasoningLabelHostWiringResult {
  wiring: ReasoningLabelWiring;
  scope: ReasoningLabelHostScope;
  markedPromise?: Promise<void>;
}

/** Computes the shared negative usage sequence from durable activity and reasoning calls. */
export function getLabelUsageSequenceSeed(
  parts: ReadonlyArray<LooseContentPart | null | undefined>,
  current = 0,
): number {
  let activityLabels = 0;
  let reasoningAttempts = 0;
  let reasoningCommittedFallback = 0;
  for (const part of parts) {
    if (part?.type === ContentTypes.ACTIVITY_LABEL) {
      activityLabels += 1;
      continue;
    }
    if (part?.type !== ContentTypes.THINK) {
      continue;
    }
    if (typeof part.reasoning_label_attempts === 'number') {
      reasoningAttempts = Math.max(reasoningAttempts, part.reasoning_label_attempts);
    }
    if (typeof part.reasoning_label_revision === 'number' && part.reasoning_label_revision > 0) {
      reasoningCommittedFallback = Math.max(
        reasoningCommittedFallback,
        part.reasoning_label_revision,
      );
    }
  }
  return Math.max(
    current,
    activityLabels + Math.max(reasoningAttempts, reasoningCommittedFallback),
  );
}

async function markResumableWithRetry(
  markResumable: () => Promise<unknown>,
  onMarkFailure?: () => void,
): Promise<void> {
  try {
    await markResumable();
  } catch {
    try {
      await markResumable();
    } catch {
      onMarkFailure?.();
    }
  }
}

/** Owns the host-side lifecycle around the pure reasoning-label stream controller. */
export function createReasoningLabelHostWiring({
  config,
  seedFromContent = false,
  abortSignal,
  markResumable,
  onMarkFailure,
  getContentParts,
  getStepIndex,
  emitEvent,
  trackPendingFill,
  generateLabel,
}: CreateReasoningLabelHostWiringOptions): ReasoningLabelHostWiringResult {
  const scope: ReasoningLabelHostScope = { closed: false, abort: new AbortController() };
  const closeOnAbort = () => {
    scope.closed = true;
    scope.abort.abort();
  };
  if (abortSignal != null) {
    if (abortSignal.aborted) {
      closeOnAbort();
    } else {
      abortSignal.addEventListener('abort', closeOnAbort, { once: true });
      scope.detach = () => abortSignal.removeEventListener('abort', closeOnAbort);
    }
  }

  const wiring = createReasoningLabelWiring({
    minChars: config.minChars,
    updateChars: config.updateChars,
    updateIntervalMs: config.updateIntervalMs,
    maxPerRun: config.maxPerRun,
    ...(!seedFromContent && { initialAttempts: 0 }),
    prompt: config.prompt,
    abortSignal: scope.abort.signal,
    isClosed: () => scope.closed,
    getContentParts,
    getStepIndex,
    emitAttemptEvent: (event) => emitEvent(ReasoningLabelEvents.ON_REASONING_LABEL_ATTEMPT, event),
    emitLabelEvent: (event) => emitEvent(ReasoningLabelEvents.ON_REASONING_LABEL, event),
    trackPendingFill,
    generateLabel,
  });

  return {
    wiring,
    scope,
    ...(markResumable != null && {
      markedPromise: markResumableWithRetry(markResumable, onMarkFailure),
    }),
  };
}

function extractLLMCompletionText(output: ReasoningLabelLLMOutput): string | undefined {
  const generations = output.generations;
  const generation = generations[generations.length - 1]?.[0] as
    | { message?: { content?: unknown }; text?: unknown }
    | undefined;
  const content = generation?.message?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === 'string') {
          return block;
        }
        const text = (block as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return typeof generation?.text === 'string' ? generation.text : undefined;
}

function serializeChatPrompt(messages: ReasoningLabelPromptMessage[][]): string {
  const content: string[] = [];
  for (const batch of messages) {
    for (const message of batch) {
      content.push(
        typeof message.content === 'string'
          ? message.content
          : (JSON.stringify(message.content ?? '') ?? ''),
      );
    }
  }
  return content.join('\n');
}

/** Invokes one SDK reasoning-label revision and captures complete provider text for billing. */
export async function generateReasoningLabelRevision({
  payload,
  run,
  resolveModel,
  sourceRunId,
  sourceTraceId,
  responseId,
  sessionId,
  userId,
  parentMessageId,
  recordUsage,
  onError,
}: GenerateReasoningLabelRevisionOptions): Promise<GeneratedReasoningLabel> {
  if (typeof run?.generateReasoningLabel !== 'function') {
    return {};
  }
  const { provider, clientOptions, endpointTokenConfig, sameEndpoint } = await resolveModel();
  const { handleLLMEnd, collected } = createMetadataAggregator();
  let sdkPromptText: string | undefined;
  let sdkCompletionText: string | undefined;
  const capturePrompt: ReasoningLabelCaptureCallback = {
    handleLLMStart: (_llm: unknown, prompts: string[]) => {
      sdkPromptText = Array.isArray(prompts) ? prompts.join('\n') : undefined;
    },
    handleChatModelStart: (_llm: unknown, messages: ReasoningLabelPromptMessage[][]) => {
      try {
        sdkPromptText = serializeChatPrompt(messages ?? []);
      } catch {
        // Providers with usage metadata do not need the estimate fallback.
      }
    },
    handleLLMEnd: (output, runId, parentRunId, tags) => {
      const completionText = extractLLMCompletionText(output);
      if (completionText != null) {
        sdkCompletionText = completionText;
      }
      handleLLMEnd(output, runId, parentRunId, tags);
    },
  };
  let label: string | undefined;
  let usage: ReasoningLabelUsageMetadata | undefined;
  let completed = false;
  try {
    ({ label, usage } = await run.generateReasoningLabel({
      provider,
      clientOptions,
      visibleReasoning: payload.visibleReasoning,
      reasoningStepId: payload.reasoningStepId,
      revision: payload.revision,
      status: payload.status,
      ...(payload.previousLabel != null && { previousLabel: payload.previousLabel }),
      ...(payload.agentId != null && { agentId: payload.agentId }),
      charLimit: payload.charLimit,
      ...(payload.prompt != null && { prompt: payload.prompt }),
      sourceRunId,
      sourceTraceId,
      responseId,
      chainOptions: {
        signal: payload.signal,
        callbacks: [capturePrompt],
        configurable: {
          thread_id: sessionId,
          ...(userId != null && { user_id: userId }),
          requestBody: { ...(parentMessageId != null && { parentMessageId }) },
        },
      },
    }));
    completed = true;
  } catch (error) {
    if (!payload.signal.aborted) {
      onError?.(error);
    }
  }

  const collectedMetadata = usage != null ? [{ usage_metadata: usage }] : collected;
  const shouldCollectUsage =
    usage != null ||
    collected.length > 0 ||
    (completed && (label != null || sdkPromptText != null || sdkCompletionText != null));
  return {
    label,
    ...(shouldCollectUsage && {
      collectUsage: (completionText?: string) =>
        recordUsage({
          collectedMetadata,
          model: clientOptions.model,
          endpointTokenConfig,
          sameEndpoint,
          provider,
          promptText: sdkPromptText ?? '',
          completionText: sdkCompletionText ?? completionText ?? '',
        }),
    }),
  };
}
